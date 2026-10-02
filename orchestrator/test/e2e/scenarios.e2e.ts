import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT } from '../../src/agents/schemas.ts';
import type { HumanDecision } from '../../src/engine/engine.ts';
import { AuditLog } from '../../src/governance/audit.ts';
import { collectMetrics } from '../../src/governance/metrics.ts';
import { writeReviewPacket } from '../../src/report/reviewPacket.ts';
import { createRun, DEFAULT_LIMITS, loadScenario, openRun, type RunHandle } from '../../src/runtime.ts';
import { listFiles, snapshotTree } from '../../src/util/fsx.ts';
import { tempDir } from '../fixtures.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCENARIOS = join(REPO, 'scenarios');
const reviewer = 'e2e-reviewer';

interface RunOptions {
  maxReworks?: number;
  faults?: string[];
}

/** Starts a run and executes it until it finishes, pauses for a person, or stops. */
async function start(scenarioName: string, targetDir: string, runsDir: string, runId: string, options: RunOptions = {}): Promise<RunHandle> {
  const scenarioDir = join(SCENARIOS, scenarioName);
  const scenario = loadScenario(scenarioDir);
  const handle = createRun(
    runsDir,
    runId,
    { scenarioId: scenario.id, scenarioDir, targetDir, mode: 'offline', maxReworks: options.maxReworks ?? 2, faults: options.faults ?? [], limits: DEFAULT_LIMITS },
    scenario.requirement,
  );
  await handle.engine.run();
  return handle;
}

/** Records a decision and resumes, each in a freshly opened run, as separate CLI invocations would. */
async function decideAndResume(runsDir: string, runId: string, stageId: string, decision: HumanDecision): Promise<RunHandle> {
  openRun(runsDir, runId).engine.submitDecision(stageId, decision, 'scripted');
  const handle = openRun(runsDir, runId);
  await handle.engine.run();
  return handle;
}

const approve = (runsDir: string, runId: string, stageId: string) => decideAndResume(runsDir, runId, stageId, { decision: 'approved', approver: reviewer });
const eventTypes = (handle: RunHandle, stageId?: string): string[] =>
  AuditLog.read(join(handle.runDir, 'audit.jsonl')).filter((event) => stageId === undefined || event.stageId === stageId).map((event) => event.type);
const waitingOn = (handle: RunHandle): string[] => Object.entries(handle.state.stages).filter(([, stage]) => stage.pendingApproval).map(([id]) => id);

describe('the three scenarios, run in order against one target', () => {
  const root = tempDir('e2e-scenarios-');
  const targetDir = join(root, 'url-shortener');
  const runsDir = join(root, 'runs');

  it('greenfield: builds the service from nothing, with design and release sign-off', async () => {
    let run = await start('01-greenfield', targetDir, runsDir, 'greenfield');
    expect(run.state.status).toBe('PAUSED');
    expect(waitingOn(run)).toEqual(['architecture']);
    expect(run.state.stages['impact-analysis']!.status).toBe('SKIPPED');
    expect(existsSync(targetDir)).toBe(false);

    run = await approve(runsDir, 'greenfield', 'architecture');
    expect(waitingOn(run)).toEqual(['release-readiness']);
    // Verified in the sandbox, and still nothing written to the target before release sign-off.
    expect(run.state.stages['build-verify']!.status).toBe('SUCCEEDED');
    expect(listFiles(targetDir)).toEqual([]);

    run = await approve(runsDir, 'greenfield', 'release-readiness');
    expect(run.state.status).toBe('SUCCEEDED');
    expect(listFiles(targetDir)).toContain('src/server.ts');
    expect(run.state.approvals.map((record) => `${record.stageId}:${record.decision}:${record.channel}`)).toEqual([
      'architecture:approved:scripted',
      'release-readiness:approved:scripted',
    ]);
  });

  it('brownfield: a failing build sends the work back, and the corrected change is released', async () => {
    let run = await start('02-brownfield', targetDir, runsDir, 'brownfield');
    expect(run.state.stages['impact-analysis']!.status).toBe('SUCCEEDED');
    const impact = run.engine.artifacts.content<{ regressionSurface: string[] }>(ARTIFACT.impact)!;
    expect(impact.regressionSurface).toContain('src/server.ts');

    run = await approve(runsDir, 'brownfield', 'architecture');
    expect(waitingOn(run)).toEqual(['release-readiness']);
    expect(run.state.stages['build-verify']).toMatchObject({ status: 'SUCCEEDED', reworksTriggered: 1, generation: 2 });
    expect(run.state.stages.implementation!.generation).toBe(2);

    const feedback = run.engine.artifacts.content<{ failures: string[] }>(ARTIFACT.buildFeedback)!;
    expect(feedback.failures.join('\n')).toContain('rejects an expiry in the past with 400');
    // The tests were re-derived with the feedback and came out identical: one version, not two.
    expect(run.state.artifacts[ARTIFACT.testChanges]).toHaveLength(1);
    expect(run.state.artifacts[ARTIFACT.codeChanges]).toHaveLength(2);
    expect(run.state.artifacts[ARTIFACT.testReport]!.map((version) => version.status)).toEqual(['rejected', 'accepted']);

    run = await approve(runsDir, 'brownfield', 'release-readiness');
    expect(run.state.status).toBe('SUCCEEDED');
    expect(listFiles(targetDir)).toContain('migrations/002_link_expiry.sql');
  });

  it('ambiguous: stops for answers, re-plans after a change request, then delivers', async () => {
    let run = await start('03-ambiguous', targetDir, runsDir, 'ambiguous');
    expect(run.state.status).toBe('PAUSED');
    expect(run.state.stages.requirements!.pendingApproval).toMatchObject({ kind: 'clarification' });
    expect(run.state.stages.requirements!.pendingApproval!.reasons.map((reason) => reason.slice(0, 3))).toEqual(['Q-1', 'Q-3', 'Q-5']);
    expect(run.state.stages.planning!.status).toBe('PENDING');

    run = await decideAndResume(runsDir, 'ambiguous', 'requirements', {
      decision: 'clarified',
      approver: 'e2e-requester',
      answers: { 'Q-1': 'Aggregate only.', 'Q-3': 'Unsafe destinations.', 'Q-5': 'Existing links too.' },
    });
    expect(waitingOn(run)).toEqual(['architecture']);
    expect(run.state.stages.requirements!.generation).toBe(2);

    run = await decideAndResume(runsDir, 'ambiguous', 'architecture', {
      decision: 'changes_requested',
      approver: reviewer,
      comment: 'Report bot and non-bot clicks separately.',
    });
    expect(waitingOn(run)).toEqual(['architecture']);
    expect(run.state.stages.requirements!.generation).toBe(3);
    expect(run.state.stages.planning!.generation).toBe(2);
    expect(run.state.stages.architecture!.generation).toBe(2);
    // The impact report was re-derived from the new specification and did not change.
    expect(run.state.artifacts[ARTIFACT.impact]).toHaveLength(1);
    expect(run.state.artifacts[ARTIFACT.design]!.map((version) => version.status)).toEqual(['rejected', 'proposed']);

    run = await approve(runsDir, 'ambiguous', 'architecture');
    run = await approve(runsDir, 'ambiguous', 'release-readiness');
    expect(run.state.status).toBe('SUCCEEDED');
  });

  it('ends with exactly the service that is checked in, with intact audit logs', () => {
    // If this fails, the recordings and the checked-in url-shortener/ have drifted apart.
    expect(snapshotTree(targetDir).treeHash).toBe(snapshotTree(join(REPO, 'url-shortener')).treeHash);

    for (const runId of ['greenfield', 'brownfield', 'ambiguous']) {
      expect(AuditLog.verify(join(runsDir, runId, 'audit.jsonl')).valid, runId).toBe(true);
    }

    // The review packet a person would read for the brownfield change.
    const run = openRun(runsDir, 'brownfield');
    const packet = writeReviewPacket({ runDir: run.runDir, state: run.state, graph: run.engine.graph, artifacts: run.engine.artifacts, workspace: run.workspace });
    const read = (name: string): string => readFileSync(join(packet, name), 'utf8');
    expect(read('README.md')).toContain('**Status: SUCCEEDED**');
    expect(read('README.md')).toContain('hash chain verified');
    expect(read('changes.diff')).toContain('+++ b/migrations/002_link_expiry.sql');
    expect(read('changes.md')).toContain('rejects an expiry in the past with 400 (passed)');
    expect(read('verification.md')).toContain('Earlier build that was sent back (rework loop 1)');
    expect(read('verification.md')).toContain('| REL-4 | Every acceptance criterion is proven by a test that passed | pass | 13/13 criteria proven |');
    expect(read('lineage.md')).toContain('REWORK_REQUESTED');
    expect(read('plan-and-design.md')).toContain('Regression surface, from the import graph');

    const metrics = collectMetrics(runsDir);
    expect(metrics).toMatchObject({ runs: 3, finishedRuns: 3, successRate: 1, rollbackFrequency: 0 });
    expect(metrics.reworkLoopsPerRun).toBeCloseTo(1 / 3);
    expect(metrics.recoveries).toBe(1);
  });
});

describe('failure paths', () => {
  const fixtureRoot = tempDir('e2e-fixture-');
  const serviceV1 = join(fixtureRoot, 'url-shortener');

  /** A fresh copy of the first version of the service, as produced by the greenfield scenario. */
  function freshTarget(): { targetDir: string; runsDir: string } {
    const root = tempDir('e2e-failure-');
    cpSync(serviceV1, join(root, 'url-shortener'), { recursive: true });
    return { targetDir: join(root, 'url-shortener'), runsDir: join(root, 'runs') };
  }

  beforeAll(async () => {
    const runsDir = join(fixtureRoot, 'runs');
    await start('01-greenfield', serviceV1, runsDir, 'fixture');
    await approve(runsDir, 'fixture', 'architecture');
    const run = await approve(runsDir, 'fixture', 'release-readiness');
    expect(run.state.status).toBe('SUCCEEDED');
  });

  it('falls back to the second agent when the first keeps failing', async () => {
    const root = tempDir('e2e-fallback-');
    const run = await start('01-greenfield', join(root, 'target'), join(root, 'runs'), 'fallback', { faults: ['planning=error:always'] });
    expect(run.state.status).toBe('PAUSED');
    expect(run.state.stages.planning).toMatchObject({ status: 'SUCCEEDED', usedFallback: true, attempts: 3 });
    expect(eventTypes(run, 'planning').filter((type) => ['STAGE_ATTEMPT_FAILED', 'FALLBACK_ACTIVATED'].includes(type))).toEqual([
      'STAGE_ATTEMPT_FAILED',
      'STAGE_ATTEMPT_FAILED',
      'FALLBACK_ACTIVATED',
    ]);
    expect(run.engine.artifacts.latest(ARTIFACT.plan)!.producedBy.actor).toBe('agent:planning:fallback');
  });

  it('rolls back and stops when the build still fails after the rework budget is spent', async () => {
    const { targetDir, runsDir } = freshTarget();
    const before = snapshotTree(targetDir).treeHash;
    await start('02-brownfield', targetDir, runsDir, 'no-rework', { maxReworks: 0 });
    const run = await approve(runsDir, 'no-rework', 'architecture');

    expect(run.state.status).toBe('SAFE_STOPPED');
    expect(run.state.stopReason).toMatch(/Stage "build-verify" failed: .*still failing after 0 rework loop\(s\)/);
    expect(run.state.stages.integrate!.status).toBe('ROLLED_BACK');
    expect(run.workspace.snapshot().treeHash).toBe(before);
    expect(snapshotTree(targetDir).treeHash).toBe(before);
    expect(eventTypes(run)).toEqual(expect.arrayContaining(['ROLLBACK_STARTED', 'COMPENSATION_EXECUTED', 'RUN_SAFE_STOPPED']));
  });

  it('restores the target when promotion fails half-way, and completes after a person authorizes a retry', async () => {
    const { targetDir, runsDir } = freshTarget();
    const before = snapshotTree(targetDir).treeHash;
    await start('02-brownfield', targetDir, runsDir, 'promote-fails', { faults: ['promote=error-after:1'] });
    await approve(runsDir, 'promote-fails', 'architecture');
    let run = await approve(runsDir, 'promote-fails', 'release-readiness');

    expect(run.state.status).toBe('SAFE_STOPPED');
    expect(run.state.stages.promote!.status).toBe('FAILED');
    // The copy happened and was undone: the target is byte-for-byte what it was.
    expect(snapshotTree(targetDir).treeHash).toBe(before);
    expect(existsSync(join(targetDir, 'migrations/002_link_expiry.sql'))).toBe(false);

    const retry = openRun(runsDir, 'promote-fails');
    retry.engine.prepareRetry(reviewer);
    run = openRun(runsDir, 'promote-fails');
    await run.engine.run();

    expect(run.state.status).toBe('SUCCEEDED');
    expect(existsSync(join(targetDir, 'migrations/002_link_expiry.sql'))).toBe(true);
    // The change is identical to the one already verified and approved, so neither was repeated.
    expect(run.state.approvals.filter((record) => record.stageId === 'release-readiness')).toHaveLength(1);
    expect(eventTypes(run, 'build-verify').filter((type) => type === 'STAGE_STARTED')).toHaveLength(2);
    expect(eventTypes(run, 'build-verify')).toContain('STAGE_REUSED');
    expect(eventTypes(run, 'release-readiness')).toContain('STAGE_REUSED');
  });

  it('leaves the target untouched when the release is rejected', async () => {
    const root = tempDir('e2e-reject-');
    const targetDir = join(root, 'target');
    const runsDir = join(root, 'runs');
    await start('01-greenfield', targetDir, runsDir, 'rejected');
    await approve(runsDir, 'rejected', 'architecture');
    const run = await decideAndResume(runsDir, 'rejected', 'release-readiness', { decision: 'rejected', approver: reviewer, comment: 'Not before the audit.' });

    expect(run.state.status).toBe('SAFE_STOPPED');
    expect(run.state.stopReason).toBe(`Stage "release-readiness" was rejected by ${reviewer}: Not before the audit.`);
    expect(listFiles(targetDir)).toEqual([]);
    expect(listFiles(run.workspace.root)).toEqual([]);
    expect(run.state.stages.promote!.status).toBe('PENDING');
  });

  it('refuses to promote when the target changed while the run was waiting for approval', async () => {
    const { targetDir, runsDir } = freshTarget();
    await start('02-brownfield', targetDir, runsDir, 'drift');
    await approve(runsDir, 'drift', 'architecture');

    // Someone else changes the target while the release waits for sign-off.
    const readme = join(targetDir, 'README.md');
    writeFileSync(readme, `${readFileSync(readme, 'utf8')}\nHotfix applied by hand.\n`);
    const drifted = snapshotTree(targetDir).treeHash;

    const run = await approve(runsDir, 'drift', 'release-readiness');
    expect(run.state.status).toBe('SAFE_STOPPED');
    expect(run.state.stopReason).toContain('[no-target-drift] the target changed after this run started');
    expect(snapshotTree(targetDir).treeHash).toBe(drifted);
    expect(readFileSync(readme, 'utf8')).toContain('Hotfix applied by hand.');
  });
});
