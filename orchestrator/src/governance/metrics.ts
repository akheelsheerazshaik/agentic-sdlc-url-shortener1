import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog, type AuditEvent } from './audit.ts';

export interface RunMetrics {
  runId: string;
  outcome: 'succeeded' | 'safe_stopped' | 'in_progress';
  stageExecutions: number;
  failedAttempts: number;
  retries: number;
  fallbacks: number;
  reworkLoops: number;
  replannedStages: number;
  rollbacks: number;
  approvals: number;
  /** First event to last event. */
  wallClockMs: number;
  /** Time the run spent paused, waiting for a person. */
  waitingOnHumansMs: number;
  /** wallClockMs minus waitingOnHumansMs: how long the automation itself took. */
  activeMs: number;
  /** Time from each first failure of a stage to that stage succeeding, in active time. */
  recoveriesMs: number[];
  unresolvedFailures: number;
}

export interface FleetMetrics {
  runs: number;
  finishedRuns: number;
  /** Succeeded runs over finished runs. */
  successRate: number | null;
  /** Retried attempts over all stage executions. */
  retryRate: number | null;
  reworkLoopsPerRun: number | null;
  /** Finished runs that rolled something back, over finished runs. */
  rollbackFrequency: number | null;
  /** Mean time to recovery: average of every failure-to-success interval, in active time. */
  mttrMs: number | null;
  recoveries: number;
  unresolvedFailures: number;
  /** End-to-end latency of succeeded runs, excluding time spent waiting for people. */
  latencyMs: { p50: number; p95: number; mean: number } | null;
  meanWaitingOnHumansMs: number | null;
  perRun: RunMetrics[];
}

const time = (event: AuditEvent): number => new Date(event.ts).getTime();

/** Intervals in which the run waited for a person: from a pause or a safe stop until the run is resumed. */
function pausedIntervals(events: AuditEvent[]): [number, number][] {
  const intervals: [number, number][] = [];
  let pausedAt: number | undefined;
  for (const event of events) {
    if (event.type === 'RUN_PAUSED' || event.type === 'RUN_SAFE_STOPPED') pausedAt = time(event);
    if (event.type === 'RUN_RESUMED' && pausedAt !== undefined) {
      intervals.push([pausedAt, time(event)]);
      pausedAt = undefined;
    }
  }
  return intervals;
}

/** Elapsed time between two instants with paused intervals removed. */
function activeBetween(from: number, to: number, paused: [number, number][]): number {
  let waiting = 0;
  for (const [start, end] of paused) {
    waiting += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  return Math.max(0, to - from - waiting);
}

/** Everything is derived from the audit log, so the metrics can always be traced back to events. */
export function runMetrics(events: AuditEvent[]): RunMetrics {
  const count = (type: string): number => events.filter((event) => event.type === type).length;
  const first = events[0];
  const last = events.at(-1);
  const paused = pausedIntervals(events);
  const wallClockMs = first && last ? time(last) - time(first) : 0;
  const waitingOnHumansMs = paused.reduce((total, [start, end]) => total + (end - start), 0);

  // A stage's incident opens at its first failure and closes when the stage next succeeds.
  const open = new Map<string, number>();
  const recoveriesMs: number[] = [];
  for (const event of events) {
    if (!event.stageId) continue;
    if ((event.type === 'STAGE_ATTEMPT_FAILED' || event.type === 'REWORK_REQUESTED') && !open.has(event.stageId)) {
      open.set(event.stageId, time(event));
    }
    if (event.type === 'STAGE_SUCCEEDED' && open.has(event.stageId)) {
      recoveriesMs.push(activeBetween(open.get(event.stageId)!, time(event), paused));
      open.delete(event.stageId);
    }
  }

  const terminal = [...events].reverse().find((event) => ['RUN_SUCCEEDED', 'RUN_SAFE_STOPPED', 'RUN_PAUSED', 'RUN_RESUMED', 'RETRY_AUTHORIZED'].includes(event.type));
  return {
    runId: first?.runId ?? '',
    outcome: terminal?.type === 'RUN_SUCCEEDED' ? 'succeeded' : terminal?.type === 'RUN_SAFE_STOPPED' ? 'safe_stopped' : 'in_progress',
    stageExecutions: count('STAGE_STARTED'),
    failedAttempts: count('STAGE_ATTEMPT_FAILED'),
    retries: events.filter((event) => event.type === 'STAGE_ATTEMPT_FAILED' && event.data.willRetry === true).length,
    fallbacks: count('FALLBACK_ACTIVATED'),
    reworkLoops: count('REWORK_REQUESTED'),
    replannedStages: count('STAGE_INVALIDATED'),
    rollbacks: count('ROLLBACK_STARTED'),
    approvals: count('APPROVAL_RECORDED'),
    wallClockMs,
    waitingOnHumansMs,
    activeMs: wallClockMs - waitingOnHumansMs,
    recoveriesMs,
    unresolvedFailures: open.size,
  };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

const mean = (values: number[]): number => values.reduce((total, value) => total + value, 0) / values.length;
const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);

export function fleetMetrics(perRun: RunMetrics[]): FleetMetrics {
  const finished = perRun.filter((run) => run.outcome !== 'in_progress');
  const succeeded = finished.filter((run) => run.outcome === 'succeeded');
  const recoveries = perRun.flatMap((run) => run.recoveriesMs);
  const latencies = succeeded.map((run) => run.activeMs).sort((a, b) => a - b);
  const executions = perRun.reduce((total, run) => total + run.stageExecutions, 0);

  return {
    runs: perRun.length,
    finishedRuns: finished.length,
    successRate: ratio(succeeded.length, finished.length),
    retryRate: ratio(perRun.reduce((total, run) => total + run.retries, 0), executions),
    reworkLoopsPerRun: ratio(perRun.reduce((total, run) => total + run.reworkLoops, 0), perRun.length),
    rollbackFrequency: ratio(finished.filter((run) => run.rollbacks > 0).length, finished.length),
    mttrMs: recoveries.length > 0 ? mean(recoveries) : null,
    recoveries: recoveries.length,
    unresolvedFailures: perRun.reduce((total, run) => total + run.unresolvedFailures, 0),
    latencyMs: latencies.length > 0 ? { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), mean: mean(latencies) } : null,
    meanWaitingOnHumansMs: succeeded.length > 0 ? mean(succeeded.map((run) => run.waitingOnHumansMs)) : null,
    perRun,
  };
}

/** Reads every run under a directory and aggregates. */
export function collectMetrics(runsDir: string): FleetMetrics {
  if (!existsSync(runsDir)) return fleetMetrics([]);
  const perRun = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(runsDir, entry.name, 'audit.jsonl')))
    .map((entry) => runMetrics(AuditLog.read(join(runsDir, entry.name, 'audit.jsonl'))))
    .sort((a, b) => a.runId.localeCompare(b.runId));
  return fleetMetrics(perRun);
}
