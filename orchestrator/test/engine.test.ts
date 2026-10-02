import { describe, expect, it } from 'vitest';
import { StageFailure, type Gate, type StageContext } from '../src/engine/types.ts';
import { AuditLog } from '../src/governance/audit.ts';
import { agent, harness, latch, stage, GENEROUS_LIMITS } from './harness.ts';

const passIf = (id: string, predicate: (outputs: Record<string, any>) => boolean, detail = 'check failed'): Gate => ({
  id,
  description: id,
  check: ({ outputs }) => (predicate(outputs ?? {}) ? { passed: true, details: ['ok'] } : { passed: false, details: [detail] }),
});

describe('scheduling', () => {
  it('runs independent stages in parallel and joins before the dependent stage', async () => {
    const order: string[] = [];
    const b = latch();
    const c = latch();
    const bothStarted = latch();
    let started = 0;
    const parallel = (id: string, hold: Promise<void>) =>
      stage(id, {
        dependsOn: ['a'],
        agent: agent(`agent:${id}`, async () => {
          order.push(`${id}:start`);
          if (++started === 2) bothStarted.release();
          await hold;
          order.push(`${id}:end`);
          return { outputs: { [`${id}-out`]: id } };
        }),
      });
    const h = harness([
      stage('a'),
      parallel('b', b.wait),
      parallel('c', c.wait),
      stage('d', { dependsOn: ['b', 'c'], agent: agent('agent:d', () => (order.push('d:start'), { outputs: { 'd-out': 1 } })) }),
    ]);

    const run = h.engine.run();
    await bothStarted.wait;
    // Both branches are in flight at once, and the join has not started.
    expect(order).toEqual(['b:start', 'c:start']);
    c.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).not.toContain('d:start');
    b.release();

    const state = await run;
    expect(state.status).toBe('SUCCEEDED');
    expect(order).toEqual(['b:start', 'c:start', 'c:end', 'b:end', 'd:start']);
  });

  it('passes each stage the accepted outputs of the stages it consumes', async () => {
    let seen: Record<string, unknown> = {};
    const h = harness([
      stage('a', { agent: agent('agent:a', () => ({ outputs: { 'a-out': { value: 42 } } })) }),
      stage('b', {
        dependsOn: ['a'],
        consumes: ['a-out', 'requirement'],
        agent: agent('agent:b', (context) => ((seen = context.inputs), { outputs: { 'b-out': 1 } })),
      }),
    ]);
    h.seed('requirement', { text: 'build it' });
    await h.engine.run();
    expect(seen).toEqual({ 'a-out': { value: 42 }, requirement: { text: 'build it' } });
  });

  it('skips a stage that is not enabled, and still runs what depends on it', async () => {
    const h = harness([
      stage('a'),
      stage('optional', { dependsOn: ['a'], enabled: () => false }),
      stage('c', { dependsOn: ['optional'] }),
    ]);
    const state = await h.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(state.stages.optional!.status).toBe('SKIPPED');
    expect(state.stages.c!.status).toBe('SUCCEEDED');
    expect(state.usage.stageExecutions).toBe(2);
  });

  it('stops safely when a required input is missing', async () => {
    const h = harness([stage('a', { consumes: ['requirement'] })]);
    const state = await h.engine.run();
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/required input "requirement" is missing/);
  });

  it('records which inputs every output was derived from', async () => {
    const h = harness([stage('a'), stage('b', { dependsOn: ['a'], consumes: ['a-out'] })]);
    await h.engine.run();
    const a = h.engine.artifacts.latest('a-out')!;
    const b = h.engine.artifacts.latest('b-out')!;
    expect(b.derivedFrom).toEqual({ 'a-out': a.hash });
    expect(h.engine.artifacts.lineage('b-out')).toEqual([
      expect.stringContaining('b-out v1'),
      expect.stringContaining('  a-out v1'),
    ]);
  });
});

describe('gates', () => {
  it('does not run the agent when an entry gate fails', async () => {
    let ran = false;
    const h = harness([
      stage('a', {
        entryGates: [{ id: 'precondition', description: '', check: () => ({ passed: false, details: ['not allowed'] }) }],
        agent: agent('agent:a', () => ((ran = true), { outputs: { 'a-out': 1 } })),
      }),
    ]);
    const state = await h.engine.run();
    expect(ran).toBe(false);
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toContain('[precondition] not allowed');
  });

  it('retries with the gate feedback when an exit gate fails, and does not publish the rejected output', async () => {
    const feedbackSeen: string[][] = [];
    const h = harness([
      stage('a', {
        retry: { maxAttempts: 3, backoffMs: 0 },
        exitGates: [passIf('quality', (outputs) => outputs['a-out'].quality >= 2, 'quality too low')],
        agent: agent('agent:a', (context) => {
          feedbackSeen.push(context.feedback);
          return { outputs: { 'a-out': { quality: context.attempt } } };
        }),
      }),
    ]);
    const state = await h.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(feedbackSeen).toEqual([[], ['[quality] quality too low']]);
    expect(state.artifacts['a-out']).toHaveLength(1);
    expect(h.engine.artifacts.content('a-out')).toEqual({ quality: 2 });
  });
});

describe('failure handling', () => {
  it('retries a failing stage with exponential backoff, up to its limit', async () => {
    let calls = 0;
    const h = harness([
      stage('a', {
        retry: { maxAttempts: 4, backoffMs: 100 },
        agent: agent('agent:a', () => {
          if (++calls < 4) throw new Error(`transient ${calls}`);
          return { outputs: { 'a-out': 'ok' } };
        }),
      }),
    ]);
    const state = await h.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(calls).toBe(4);
    expect(h.sleeps).toEqual([100, 200, 400]);
    expect(h.types('a').filter((type) => type === 'STAGE_ATTEMPT_FAILED')).toHaveLength(3);
  });

  it('switches to the fallback agent when the primary exhausts its attempts', async () => {
    const h = harness([
      stage('a', {
        retry: { maxAttempts: 2, backoffMs: 0 },
        agent: agent('agent:primary', () => {
          throw new Error('model unavailable');
        }),
        fallback: agent('agent:fallback', (context) => ({ outputs: { 'a-out': { fallback: context.usingFallback } } })),
      }),
    ]);
    const state = await h.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(state.stages.a!.usedFallback).toBe(true);
    expect(state.stages.a!.attempts).toBe(3);
    expect(h.engine.artifacts.content('a-out')).toEqual({ fallback: true });
    expect(h.engine.artifacts.latest('a-out')!.producedBy.actor).toBe('agent:fallback');
    expect(h.types('a')).toContain('FALLBACK_ACTIVATED');
  });

  it('does not repeat a non-retryable failure, and goes straight to the fallback', async () => {
    let calls = 0;
    const h = harness([
      stage('a', {
        retry: { maxAttempts: 5, backoffMs: 0 },
        agent: agent('agent:a', () => {
          calls++;
          throw new StageFailure('invalid API key', { retryable: false });
        }),
        fallback: agent('agent:fallback', () => ({ outputs: { 'a-out': 'from fallback' } })),
      }),
    ]);
    const state = await h.engine.run();
    expect(calls).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(state.status).toBe('SUCCEEDED');
    expect(h.engine.artifacts.content('a-out')).toBe('from fallback');
  });

  it('stops safely on a non-retryable failure when there is no fallback', async () => {
    let calls = 0;
    const h = harness([
      stage('a', {
        retry: { maxAttempts: 5, backoffMs: 0 },
        agent: agent('agent:a', () => {
          calls++;
          throw new StageFailure('policy violation', { retryable: false });
        }),
      }),
    ]);
    const state = await h.engine.run();
    expect(calls).toBe(1);
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/policy violation/);
  });

  it('rolls back side effects in reverse order and stops safely when recovery is exhausted', async () => {
    const undone: string[] = [];
    const h = harness([
      stage('apply-1', { compensate: async () => void undone.push('apply-1') }),
      stage('apply-2', { dependsOn: ['apply-1'], compensate: async () => void undone.push('apply-2') }),
      stage('no-side-effects', { dependsOn: ['apply-2'] }),
      stage('breaks', {
        dependsOn: ['no-side-effects'],
        agent: agent('agent:breaks', () => {
          throw new Error('boom');
        }),
      }),
      stage('never', { dependsOn: ['breaks'] }),
    ]);
    const state = await h.engine.run();
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/Stage "breaks" failed/);
    expect(undone).toEqual(['apply-2', 'apply-1']);
    expect(state.stages['apply-1']!.status).toBe('ROLLED_BACK');
    expect(state.stages['apply-2']!.status).toBe('ROLLED_BACK');
    expect(state.stages.breaks!.status).toBe('FAILED');
    expect(state.stages.never!.status).toBe('PENDING');
    expect(h.types()).toEqual(expect.arrayContaining(['ROLLBACK_STARTED', 'COMPENSATION_EXECUTED', 'RUN_SAFE_STOPPED']));
  });

  it('reports an incomplete rollback instead of hiding it', async () => {
    const h = harness([
      stage('apply', {
        compensate: async () => {
          throw new Error('backup missing');
        },
      }),
      stage('breaks', { dependsOn: ['apply'], agent: agent('agent:breaks', () => { throw new Error('boom'); }) }),
    ]);
    const state = await h.engine.run();
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/ROLLBACK INCOMPLETE.*apply: backup missing/);
  });

  it('aborts a stage that exceeds its timeout and treats it as a failed attempt', async () => {
    let aborted = false;
    const h = harness([
      stage('slow', {
        timeoutMs: 20,
        retry: { maxAttempts: 2, backoffMs: 0 },
        agent: agent('agent:slow', async (context: StageContext) => {
          if (context.attempt === 1) {
            await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => ((aborted = true), resolve())));
            throw new Error('aborted');
          }
          return { outputs: { 'slow-out': 'second attempt' } };
        }),
      }),
    ]);
    const state = await h.engine.run();
    expect(aborted).toBe(true);
    expect(state.status).toBe('SUCCEEDED');
    expect(h.events().find((event) => event.type === 'STAGE_ATTEMPT_FAILED')!.data.error).toMatch(/timed out after 20 ms/);
  });

  it('stays stopped until a person authorizes a retry, then resumes from the failed stage', async () => {
    let healthy = false;
    const executions: string[] = [];
    const stages = [
      stage('a', { agent: agent('agent:a', () => (executions.push('a'), { outputs: { 'a-out': 1 } })) }),
      stage('b', {
        dependsOn: ['a'],
        agent: agent('agent:b', () => {
          executions.push('b');
          if (!healthy) throw new Error('dependency down');
          return { outputs: { 'b-out': 1 } };
        }),
      }),
    ];
    const first = harness(stages);
    expect((await first.engine.run()).status).toBe('SAFE_STOPPED');

    const stillStopped = first.reopen();
    expect((await stillStopped.engine.run()).status).toBe('SAFE_STOPPED');
    expect(executions).toEqual(['a', 'b']);

    healthy = true;
    const retried = first.reopen();
    expect(() => retried.engine.prepareRetry('agent:b')).toThrowError(/not a person/);
    retried.engine.prepareRetry('alice');
    const state = await retried.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    // "a" had succeeded and is not repeated.
    expect(executions).toEqual(['a', 'b', 'b']);
    expect(retried.types()).toContain('RETRY_AUTHORIZED');
  });
});

describe('rework loops', () => {
  /** build -> verify, where verify rejects the build until it has been reworked `failuresBeforePass` times. */
  function buildAndVerify(failuresBeforePass: number, max: number) {
    const builds: { generation: number; feedback: unknown }[] = [];
    const stages = [
      stage('build', {
        consumesOptional: ['verify-feedback'],
        agent: agent('agent:build', (context) => {
          builds.push({ generation: context.generation, feedback: context.inputs['verify-feedback'] });
          return { outputs: { 'build-out': { revision: context.generation } } };
        }),
      }),
      stage('verify', {
        dependsOn: ['build'],
        consumes: ['build-out'],
        rework: { feedbackArtifact: 'verify-feedback', max },
        exitGates: [passIf('tests-pass', (outputs) => outputs['verify-out'].revision > failuresBeforePass, 'tests failed')],
        agent: agent('agent:verify', (context) => ({
          outputs: { 'verify-out': { revision: (context.inputs['build-out'] as { revision: number }).revision } },
        })),
      }),
      stage('release', { dependsOn: ['verify'] }),
    ];
    return { stages, builds };
  }

  it('sends a failed verification back upstream with feedback and re-runs everything it affects', async () => {
    const { stages, builds } = buildAndVerify(1, 2);
    const h = harness(stages);
    const state = await h.engine.run();

    expect(state.status).toBe('SUCCEEDED');
    expect(builds).toHaveLength(2);
    expect(builds[0]).toEqual({ generation: 1, feedback: undefined });
    expect(builds[1]!.generation).toBe(2);
    expect(builds[1]!.feedback).toMatchObject({ fromStage: 'verify', iteration: 1, failures: ['[tests-pass] tests failed'] });
    expect(state.stages.verify!.reworksTriggered).toBe(1);
    expect(state.stages.verify!.generation).toBe(2);
    // The rejected result is kept as evidence but is not what downstream stages see.
    expect(state.artifacts['verify-out']!.map((version) => version.status)).toEqual(['rejected', 'accepted']);
    expect(h.types('verify')).toContain('REWORK_REQUESTED');
    expect(h.types('build')).toContain('STAGE_INVALIDATED');
  });

  it('stops safely once the rework limit is reached', async () => {
    const { stages, builds } = buildAndVerify(99, 2);
    const h = harness(stages);
    const state = await h.engine.run();

    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/still failing after 2 rework loop\(s\)/);
    expect(builds).toHaveLength(3);
    expect(state.stages.release!.status).toBe('PENDING');
  });
});

describe('re-planning when upstream output changes', () => {
  it('re-runs only the stages whose inputs actually changed', async () => {
    const executions: string[] = [];
    const track = (id: string, outputs: (context: StageContext) => Record<string, unknown>) =>
      agent(`agent:${id}`, (context) => (executions.push(id), { outputs: outputs(context) }));

    const stages = [
      stage('spec', {
        consumes: ['requirement'],
        consumesOptional: ['change-requests'],
        agent: track('spec', (context) => ({
          'spec-out': { scope: context.inputs['change-requests'] ? 'revised' : 'original' },
        })),
      }),
      // Depends on the spec but produces the same thing whatever it says: downstream of it must be reused.
      stage('estimate', { dependsOn: ['spec'], consumes: ['spec-out'], agent: track('estimate', () => ({ 'estimate-out': { days: 3 } })) }),
      stage('budget', { dependsOn: ['estimate'], consumes: ['estimate-out'], agent: track('budget', () => ({ 'budget-out': 'approved' })) }),
      stage('design', {
        dependsOn: ['spec'],
        consumes: ['spec-out'],
        approval: { phase: 'after', required: () => ({ kind: 'approval', reasons: ['design sign-off'] }) },
        agent: track('design', (context) => ({ 'design-out': { for: (context.inputs['spec-out'] as { scope: string }).scope } })),
      }),
      stage('build', { dependsOn: ['design', 'budget'], consumes: ['design-out'], agent: track('build', () => ({ 'build-out': 1 })) }),
    ];
    const h = harness(stages);
    h.seed('requirement', { text: 'do the thing' });

    expect((await h.engine.run()).status).toBe('PAUSED');
    expect(executions).toEqual(['spec', 'estimate', 'design', 'budget']);

    const review = h.reopen();
    review.engine.submitDecision('design', { decision: 'changes_requested', approver: 'alice', comment: 'cover the audit case too' }, 'cli');
    expect((await review.engine.run()).status).toBe('PAUSED');
    // spec re-ran because of the change request; estimate re-ran because the spec changed;
    // budget did not, because the estimate came out identical.
    expect(executions.slice(4)).toEqual(['spec', 'estimate', 'design']);
    expect(review.types('budget')).toContain('STAGE_REUSED');
    expect(review.state.stages.spec!.generation).toBe(2);
    expect(review.engine.artifacts.content('change-requests')).toMatchObject({
      requests: [{ raisedAt: 'design', by: 'alice', request: 'cover the audit case too' }],
    });

    const approve = review.reopen();
    approve.engine.submitDecision('design', { decision: 'approved', approver: 'alice' }, 'cli');
    const state = await approve.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(executions.slice(7)).toEqual(['build']);
    expect(approve.engine.artifacts.content('design-out')).toEqual({ for: 'revised' });
    expect(state.artifacts['design-out']!.map((version) => version.status)).toEqual(['rejected', 'accepted']);
  });

  it('voids a pending approval when the content it covers changes', async () => {
    const stages = [
      stage('spec', {
        consumes: ['requirement'],
        agent: agent('agent:spec', (context) => ({ outputs: { 'spec-out': context.inputs.requirement } })),
      }),
      stage('design', {
        dependsOn: ['spec'],
        consumes: ['spec-out'],
        approval: { phase: 'after', required: () => ({ kind: 'approval', reasons: ['sign-off'] }) },
        agent: agent('agent:design', (context) => ({ outputs: { 'design-out': { basedOn: context.inputs['spec-out'] } } })),
      }),
    ];
    const h = harness(stages);
    h.seed('requirement', { text: 'v1' });
    await h.engine.run();
    const firstRequest = h.state.stages.design!.pendingApproval!.subjectHash;

    const changed = h.reopen();
    changed.seed('requirement', { text: 'v2' });
    await changed.engine.run();

    expect(changed.types('design')).toContain('APPROVAL_VOIDED');
    expect(changed.state.stages.design!.pendingApproval!.subjectHash).not.toBe(firstRequest);
    expect(changed.state.artifacts['design-out']!.map((version) => version.status)).toEqual(['superseded', 'proposed']);
  });
});

describe('human approval', () => {
  const approvalStages = (log: string[] = []) => [
    stage('plan'),
    stage('deploy', {
      dependsOn: ['plan'],
      consumes: ['plan-out'],
      approval: { phase: 'before', required: () => ({ kind: 'approval', reasons: ['changes production'] }) },
      compensate: async () => void log.push('deploy undone'),
      agent: agent('agent:deploy', () => (log.push('deployed'), { outputs: { 'deploy-out': 1 } })),
    }),
    stage('announce', { dependsOn: ['deploy'] }),
  ];

  it('does not perform a high-impact action until a person approves it', async () => {
    const log: string[] = [];
    const h = harness(approvalStages(log));
    const paused = await h.engine.run();
    expect(paused.status).toBe('PAUSED');
    expect(log).toEqual([]);
    expect(paused.stages.deploy!.pendingApproval).toMatchObject({ phase: 'before', kind: 'approval', reasons: ['changes production'] });

    const resumed = h.reopen();
    resumed.engine.submitDecision('deploy', { decision: 'approved', approver: 'alice', comment: 'ok' }, 'cli');
    const state = await resumed.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(log).toEqual(['deployed']);
    expect(state.approvals).toMatchObject([{ stageId: 'deploy', decision: 'approved', approver: 'alice', channel: 'cli' }]);
  });

  it('holds proposed output back from downstream stages until it is approved', async () => {
    let downstreamRan = false;
    const stages = [
      stage('design', { approval: { phase: 'after', required: () => ({ kind: 'approval', reasons: ['sign-off'] }) } }),
      stage('build', { dependsOn: ['design'], consumes: ['design-out'], agent: agent('agent:build', () => ((downstreamRan = true), { outputs: { 'build-out': 1 } })) }),
    ];
    const h = harness(stages);
    await h.engine.run();
    expect(downstreamRan).toBe(false);
    expect(h.engine.artifacts.latest('design-out')).toBeUndefined();
    expect(h.engine.artifacts.latest('design-out', 'proposed')).toBeDefined();
  });

  it('asks only when the rule says the change needs a person', async () => {
    const stages = [
      stage('change', {
        approval: {
          phase: 'after',
          required: ({ outputs }) => ((outputs!['change-out'] as { risky: boolean }).risky ? { kind: 'approval', reasons: ['risky'] } : null),
        },
        agent: agent('agent:change', () => ({ outputs: { 'change-out': { risky: false } } })),
      }),
    ];
    const state = await harness(stages).engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(state.approvals).toEqual([]);
  });

  it('rolls back and stops when a person rejects', async () => {
    const log: string[] = [];
    const stages = [
      stage('apply', { compensate: async () => void log.push('apply undone') }),
      stage('release', { dependsOn: ['apply'], approval: { phase: 'after', required: () => ({ kind: 'approval', reasons: ['release'] }) } }),
    ];
    const h = harness(stages);
    await h.engine.run();

    const rejected = h.reopen();
    rejected.engine.submitDecision('release', { decision: 'rejected', approver: 'alice', comment: 'not this quarter' }, 'cli');
    const state = await rejected.engine.run();
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toBe('Stage "release" was rejected by alice: not this quarter');
    expect(log).toEqual(['apply undone']);
    expect(state.artifacts['release-out']!.at(-1)!.status).toBe('rejected');
  });

  it('accepts decisions only from people, and only with a reason when declining', async () => {
    const h = harness(approvalStages());
    await h.engine.run();
    const decide = (approver: string, decision: 'approved' | 'rejected' = 'approved', comment = '') =>
      h.engine.submitDecision('deploy', { decision, approver, comment } as never, 'cli');

    expect(() => decide('agent:deploy')).toThrowError(/not a person/);
    expect(() => decide('orchestrator')).toThrowError(/not a person/);
    expect(() => decide('  ')).toThrowError(/identity is required/);
    expect(() => decide('alice', 'rejected', '')).toThrowError(/needs a comment/);
    expect(() => h.engine.submitDecision('plan', { decision: 'approved', approver: 'alice' }, 'cli')).toThrowError(/not waiting/);
    expect(h.state.approvals).toEqual([]);
  });

  it('feeds clarification answers back in and re-runs the stage that asked', async () => {
    const stages = [
      stage('requirements', {
        consumes: ['requirement'],
        consumesOptional: ['clarifications'],
        approval: {
          phase: 'after',
          required: ({ outputs }) =>
            (outputs!['requirements-out'] as { open: string[] }).open.length > 0
              ? { kind: 'clarification', reasons: ['Q-1 must be answered'] }
              : null,
        },
        agent: agent('agent:requirements', (context) => {
          const answers = (context.inputs.clarifications as { answers: Record<string, string> } | undefined)?.answers ?? {};
          return { outputs: { 'requirements-out': { open: answers['Q-1'] ? [] : ['Q-1'], answers } } };
        }),
      }),
      stage('plan', { dependsOn: ['requirements'], consumes: ['requirements-out'] }),
    ];
    const h = harness(stages);
    h.seed('requirement', { text: 'make it better' });
    const paused = await h.engine.run();
    expect(paused.stages.requirements!.pendingApproval!.kind).toBe('clarification');

    const answered = h.reopen();
    answered.engine.submitDecision('requirements', { decision: 'clarified', approver: 'alice', answers: { 'Q-1': 'aggregate only' } }, 'cli');
    const state = await answered.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(state.stages.requirements!.generation).toBe(2);
    expect(answered.engine.artifacts.content('requirements-out')).toEqual({ open: [], answers: { 'Q-1': 'aggregate only' } });
  });

  it('supports an interactive provider that decides while the run is live', async () => {
    const asked: string[] = [];
    const h = harness(approvalStages(), {
      approvalProvider: async (request) => {
        asked.push(`${request.stageId}:${request.phase}`);
        return { decision: { decision: 'approved', approver: 'alice' }, channel: 'interactive' };
      },
    });
    const state = await h.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(asked).toEqual(['deploy:before']);
    expect(state.approvals[0]!.channel).toBe('interactive');
  });
});

describe('safe stop and autonomy limits', () => {
  it('stops at the operator kill switch and undoes only the interrupted action', async () => {
    let stop = false;
    const log: string[] = [];
    const stages = [
      stage('a', { compensate: async () => void log.push('a undone') }),
      stage('b', {
        dependsOn: ['a'],
        compensate: async () => void log.push('b undone'),
        agent: agent('agent:b', async (context) => {
          stop = true;
          await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()));
          throw new Error('interrupted');
        }),
      }),
      stage('c', { dependsOn: ['a'], agent: agent('agent:c', async () => (await new Promise((r) => setTimeout(r, 5)), { outputs: { 'c-out': 1 } })) }),
    ];
    const h = harness(stages, { stopRequested: () => stop });
    const state = await h.engine.run();

    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toBe('Stopped by the operator.');
    // Only the action that was cut off is undone. Completed work is kept so the run can continue.
    expect(log).toEqual(['b undone']);
    expect(state.stages.a!.status).toBe('SUCCEEDED');
    expect(state.stages.b!.status).toBe('ROLLED_BACK');
    expect(h.types()).toContain('STOP_REQUESTED');
  });

  it('stops when the stage-execution budget is used up', async () => {
    const h = harness([stage('a'), stage('b', { dependsOn: ['a'] }), stage('c', { dependsOn: ['b'] })], {
      limits: { ...GENEROUS_LIMITS, maxStageExecutions: 2 },
    });
    const state = await h.engine.run();
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/Autonomy budget exceeded: stage executions \(2\/2\)/);
    expect(state.stages.c!.status).toBe('PENDING');
  });

  it('stops when the model-call budget is used up', async () => {
    const h = harness(
      [
        stage('a', { agent: agent('agent:a', () => (h.engine.recordModelCall(), h.engine.recordModelCall(), { outputs: { 'a-out': 1 } })) }),
        stage('b', { dependsOn: ['a'] }),
      ],
      { limits: { ...GENEROUS_LIMITS, maxModelCalls: 1 } },
    );
    const state = await h.engine.run();
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/model calls \(2\/1\)/);
  });
});

describe('durability', () => {
  it('re-runs a stage that a crashed process left running', async () => {
    let crash = true;
    const reachedB = latch();
    const executions: string[] = [];
    const stages = [
      stage('a', { agent: agent('agent:a', () => (executions.push('a'), { outputs: { 'a-out': 1 } })) }),
      stage('b', {
        dependsOn: ['a'],
        agent: agent('agent:b', async () => {
          executions.push('b');
          if (crash) {
            reachedB.release();
            await new Promise(() => {}); // the process "dies" here: this never returns
          }
          return { outputs: { 'b-out': 1 } };
        }),
      }),
    ];
    const h = harness(stages);
    void h.engine.run();
    await reachedB.wait;

    // What a new process finds on disk after the crash.
    crash = false;
    const recovered = h.reopen();
    expect(recovered.state.stages.b!.status).toBe('RUNNING');
    const state = await recovered.engine.run();

    expect(state.status).toBe('SUCCEEDED');
    expect(recovered.types('b')).toContain('STAGE_RECOVERED');
    expect(executions).toEqual(['a', 'b', 'b']);
  });

  it('undoes a half-finished side effect left by a crash before running the stage again', async () => {
    let crash = true;
    const reached = latch();
    const log: string[] = [];
    const stages = [
      stage('deploy', {
        compensate: async () => void log.push('undone'),
        agent: agent('agent:deploy', async () => {
          log.push('started');
          if (crash) {
            reached.release();
            await new Promise(() => {}); // dies with the action half done
          }
          return { outputs: { 'deploy-out': 1 } };
        }),
      }),
    ];
    const h = harness(stages);
    void h.engine.run();
    await reached.wait;

    crash = false;
    const recovered = h.reopen();
    const state = await recovered.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(log).toEqual(['started', 'undone', 'started']);
    expect(recovered.types('deploy')).toEqual(expect.arrayContaining(['COMPENSATION_EXECUTED', 'STAGE_RECOVERED']));
  });

  it('stops rather than building on a half-finished action it cannot undo', async () => {
    let crash = true;
    const reached = latch();
    let runs = 0;
    const stages = [
      stage('deploy', {
        compensate: async () => {
          throw new Error('backup is unreadable');
        },
        agent: agent('agent:deploy', async () => {
          runs++;
          if (crash) {
            reached.release();
            await new Promise(() => {});
          }
          return { outputs: { 'deploy-out': 1 } };
        }),
      }),
    ];
    const h = harness(stages);
    void h.engine.run();
    await reached.wait;

    crash = false;
    const state = await h.reopen().engine.run();
    expect(state.status).toBe('SAFE_STOPPED');
    expect(state.stopReason).toMatch(/was interrupted and could not be undone: backup is unreadable/);
    expect(runs).toBe(1);
  });

  it('writes an audit log whose chain verifies after a run with retries, rework and approvals', async () => {
    let calls = 0;
    const stages = [
      stage('a', {
        retry: { maxAttempts: 2, backoffMs: 0 },
        approval: { phase: 'after', required: () => ({ kind: 'approval', reasons: ['x'] }) },
        agent: agent('agent:a', () => {
          if (++calls === 1) throw new Error('flaky');
          return { outputs: { 'a-out': 1 }, decisions: [{ decision: 'use X', rationale: 'simpler', alternatives: ['Y'] }] };
        }),
      }),
    ];
    const h = harness(stages, {
      approvalProvider: async () => ({ decision: { decision: 'approved', approver: 'alice' }, channel: 'scripted' }),
    });
    const state = await h.engine.run();
    expect(state.status).toBe('SUCCEEDED');
    expect(AuditLog.verify(h.auditFile).valid).toBe(true);
    expect(state.decisions).toMatchObject([{ stageId: 'a', decision: 'use X', rationale: 'simpler', alternatives: ['Y'] }]);

    const events = h.events();
    expect(events.every((event) => event.runId === 'run-1' && event.actor.id !== '')).toBe(true);
    expect(events.find((event) => event.type === 'APPROVAL_RECORDED')!.actor).toEqual({ kind: 'human', id: 'alice' });
    expect(events.find((event) => event.type === 'STAGE_STARTED')!.actor).toEqual({ kind: 'agent', id: 'agent:a' });
  });
});
