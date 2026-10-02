import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunState, WorkflowEngine, type EngineOptions } from '../src/engine/engine.ts';
import type { Agent, BudgetLimits, RunState, StageContext, StageDefinition, StageResult } from '../src/engine/types.ts';
import { AuditLog, type AuditEvent } from '../src/governance/audit.ts';
import { readJson } from '../src/util/fsx.ts';

export const GENEROUS_LIMITS: BudgetLimits = { maxStageExecutions: 200, maxModelCalls: 200, maxActiveMs: 600_000 };

export function agent(id: string, run: (context: StageContext) => Promise<StageResult> | StageResult): Agent {
  return { id, run: async (context) => run(context) };
}

/** A stage that produces `<id>-out` unless told otherwise. */
export function stage(id: string, overrides: Partial<StageDefinition> = {}): StageDefinition {
  const produces = overrides.produces ?? [`${id}-out`];
  return {
    id,
    title: id,
    dependsOn: [],
    consumes: [],
    produces,
    agent: agent(`agent:${id}`, () => ({ outputs: Object.fromEntries(produces.map((name) => [name, { from: id }])) })),
    retry: { maxAttempts: 1, backoffMs: 0 },
    ...overrides,
  };
}

export interface Harness {
  engine: WorkflowEngine;
  state: RunState;
  runDir: string;
  auditFile: string;
  sleeps: number[];
  events: () => AuditEvent[];
  types: (stageId?: string) => string[];
  seed: (name: string, content: unknown) => void;
  /** A new engine over the state saved on disk, as a separate process would create after a pause. */
  reopen: (overrides?: Partial<EngineOptions>) => Harness;
}

export function harness(stages: StageDefinition[], overrides: Partial<EngineOptions> = {}, existingRunDir?: string): Harness {
  const runDir = existingRunDir ?? mkdtempSync(join(tmpdir(), 'engine-'));
  const auditFile = join(runDir, 'audit.jsonl');
  const state = existingRunDir
    ? readJson<RunState>(join(runDir, 'state.json'))
    : newRunState('run-1', 'test-workflow', {}, new Date('2026-01-01T00:00:00Z'));
  const sleeps: number[] = [];
  const engine = new WorkflowEngine({
    runDir,
    workflow: { id: 'test-workflow', stages },
    state,
    audit: new AuditLog(auditFile, state.runId),
    limits: GENEROUS_LIMITS,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  const events = (): AuditEvent[] => AuditLog.read(auditFile);
  return {
    engine,
    state,
    runDir,
    auditFile,
    sleeps,
    events,
    types: (stageId) => events().filter((event) => stageId === undefined || event.stageId === stageId).map((event) => event.type),
    seed: (name, content) => {
      engine.artifacts.publish(name, content, {
        status: 'accepted',
        producedBy: { stageId: 'external', generation: 0, attempt: 0, actor: 'test' },
        derivedFrom: {},
        at: '2026-01-01T00:00:00.000Z',
      });
    },
    reopen: (next = {}) => harness(stages, { ...overrides, ...next }, runDir),
  };
}

/** Resolves when `release()` is called; lets a test hold a stage open to observe concurrency. */
export function latch(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
