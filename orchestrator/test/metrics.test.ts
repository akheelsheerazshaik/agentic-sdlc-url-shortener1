import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../src/governance/audit.ts';
import { fleetMetrics, runMetrics } from '../src/governance/metrics.ts';

/** Builds a run's events from (seconds, type, stage, data) tuples. */
function events(runId: string, rows: [number, string, string?, Record<string, unknown>?][]): AuditEvent[] {
  return rows.map(([second, type, stageId, data], index) => ({
    seq: index + 1,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    runId,
    type,
    ...(stageId ? { stageId } : {}),
    actor: { kind: 'engine', id: 'orchestrator' },
    data: data ?? {},
    prevHash: '',
    hash: '',
  }));
}

describe('runMetrics', () => {
  it('separates active time from time spent waiting for people', () => {
    const metrics = runMetrics(
      events('r1', [
        [0, 'RUN_STARTED'],
        [1, 'STAGE_STARTED', 'a'],
        [2, 'STAGE_SUCCEEDED', 'a'],
        [3, 'RUN_PAUSED'],
        [63, 'RUN_RESUMED'],
        [64, 'STAGE_STARTED', 'b'],
        [66, 'STAGE_SUCCEEDED', 'b'],
        [66, 'RUN_SUCCEEDED'],
      ]),
    );
    expect(metrics).toMatchObject({ outcome: 'succeeded', stageExecutions: 2, wallClockMs: 66_000, waitingOnHumansMs: 60_000, activeMs: 6000 });
  });

  it('measures recovery from the first failure of a stage to its success, excluding human wait', () => {
    const metrics = runMetrics(
      events('r1', [
        [0, 'RUN_STARTED'],
        [1, 'STAGE_STARTED', 'build'],
        [2, 'STAGE_ATTEMPT_FAILED', 'build', { willRetry: true }],
        [3, 'STAGE_STARTED', 'build'],
        [4, 'STAGE_ATTEMPT_FAILED', 'build', { willRetry: false }],
        [5, 'RUN_SAFE_STOPPED'],
        [105, 'RETRY_AUTHORIZED'],
        [105, 'RUN_RESUMED'],
        [106, 'STAGE_STARTED', 'build'],
        [108, 'STAGE_SUCCEEDED', 'build'],
        [108, 'RUN_SUCCEEDED'],
      ]),
    );
    // Failure at 2 s, success at 108 s, minus the 100 s the run sat stopped: 6 s.
    expect(metrics.recoveriesMs).toEqual([6000]);
    expect(metrics).toMatchObject({ failedAttempts: 2, retries: 1, unresolvedFailures: 0, outcome: 'succeeded' });
  });

  it('counts a rework loop as a failure that is recovered when the stage finally passes', () => {
    const metrics = runMetrics(
      events('r1', [
        [0, 'RUN_STARTED'],
        [5, 'REWORK_REQUESTED', 'build-verify'],
        [6, 'STAGE_INVALIDATED', 'implementation'],
        [6, 'STAGE_INVALIDATED', 'integrate'],
        [15, 'STAGE_SUCCEEDED', 'build-verify'],
        [16, 'RUN_SUCCEEDED'],
      ]),
    );
    expect(metrics).toMatchObject({ reworkLoops: 1, replannedStages: 2, recoveriesMs: [10_000] });
  });

  it('reports a failure that was never recovered', () => {
    const metrics = runMetrics(
      events('r1', [
        [0, 'RUN_STARTED'],
        [1, 'STAGE_ATTEMPT_FAILED', 'promote', { willRetry: false }],
        [2, 'ROLLBACK_STARTED'],
        [3, 'RUN_SAFE_STOPPED'],
      ]),
    );
    expect(metrics).toMatchObject({ outcome: 'safe_stopped', rollbacks: 1, unresolvedFailures: 1, recoveriesMs: [] });
  });

  it('reports a paused run as in progress', () => {
    expect(runMetrics(events('r1', [[0, 'RUN_STARTED'], [1, 'RUN_PAUSED']])).outcome).toBe('in_progress');
  });
});

describe('fleetMetrics', () => {
  const succeeded = (runId: string, activeSeconds: number, extra: [number, string, string?, Record<string, unknown>?][] = []) =>
    runMetrics(events(runId, [[0, 'RUN_STARTED'], [0, 'STAGE_STARTED', 'a'], ...extra, [activeSeconds, 'RUN_SUCCEEDED']]));

  it('aggregates success rate, retry rate, rollback frequency, MTTR and latency', () => {
    const runs = [
      succeeded('r1', 10),
      succeeded('r2', 20, [[2, 'STAGE_ATTEMPT_FAILED', 'a', { willRetry: true }], [3, 'STAGE_STARTED', 'a'], [6, 'STAGE_SUCCEEDED', 'a']]),
      succeeded('r3', 30, [[1, 'REWORK_REQUESTED', 'a'], [3, 'STAGE_SUCCEEDED', 'a']]),
      runMetrics(events('r4', [[0, 'RUN_STARTED'], [0, 'STAGE_STARTED', 'a'], [1, 'STAGE_ATTEMPT_FAILED', 'a', { willRetry: false }], [2, 'ROLLBACK_STARTED'], [3, 'RUN_SAFE_STOPPED']])),
      runMetrics(events('r5', [[0, 'RUN_STARTED'], [1, 'RUN_PAUSED']])),
    ];
    const fleet = fleetMetrics(runs);

    expect(fleet.runs).toBe(5);
    expect(fleet.finishedRuns).toBe(4);
    expect(fleet.successRate).toBe(0.75);
    expect(fleet.retryRate).toBe(1 / 5); // one retried attempt out of five stage executions
    expect(fleet.reworkLoopsPerRun).toBe(1 / 5);
    expect(fleet.rollbackFrequency).toBe(0.25);
    expect(fleet.mttrMs).toBe(3000); // recoveries of 4 s and 2 s
    expect(fleet.recoveries).toBe(2);
    expect(fleet.unresolvedFailures).toBe(1);
    expect(fleet.latencyMs).toEqual({ p50: 20_000, p95: 30_000, mean: 20_000 });
  });

  it('reports "not available" rather than zero when there is nothing to measure', () => {
    const fleet = fleetMetrics([]);
    expect(fleet).toMatchObject({ runs: 0, successRate: null, retryRate: null, rollbackFrequency: null, mttrMs: null, latencyMs: null });
  });
});
