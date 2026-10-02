import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARTIFACT } from './agents/schemas.ts';
import type { AgentDeps, RequirementInput } from './agents/support.ts';
import { ArtifactStore } from './engine/artifacts.ts';
import { newRunState, WorkflowEngine, type ApprovalProvider } from './engine/engine.ts';
import { parseFault, type FaultLedger } from './engine/faults.ts';
import type { BudgetLimits, RunState } from './engine/types.ts';
import { AuditLog, ENGINE, type Actor, type AuditEvent } from './governance/audit.ts';
import { defaultPolicyEngine } from './governance/rules/index.ts';
import { AnthropicGateway } from './model/anthropic.ts';
import { MeteredGateway, type ModelGateway } from './model/gateway.ts';
import { RecordedGateway } from './model/recorded.ts';
import { buildCodeIndex } from './tools/codeIndex.ts';
import { CommandRunner, NODE_SERVICE_COMMANDS } from './tools/commandRunner.ts';
import { Workspace } from './tools/workspace.ts';
import { displayPath, readJson, writeJsonAtomic } from './util/fsx.ts';
import { sdlcWorkflow } from './workflow/sdlcWorkflow.ts';

export type Mode = 'offline' | 'live';

/** Everything that defines a run. Stored in the run state, so a resumed run is wired exactly as it started. */
export interface RunParams {
  scenarioId: string;
  /** Directory holding the scenario's requirement and recordings; absent for a requirement given on the command line. */
  scenarioDir?: string | undefined;
  targetDir: string;
  mode: Mode;
  maxReworks: number;
  faults: string[];
  limits: BudgetLimits;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxStageExecutions: 60,
  maxModelCalls: 60,
  maxActiveMs: 30 * 60 * 1000,
};

export interface Scenario {
  id: string;
  title: string;
  type: 'greenfield' | 'brownfield' | 'ambiguous';
  requirement: RequirementInput;
}

export function loadScenario(scenarioDir: string): Scenario {
  const manifest = readJson<{ id: string; title: string; type: Scenario['type'] }>(join(scenarioDir, 'scenario.json'));
  return {
    ...manifest,
    requirement: {
      title: manifest.title,
      text: readFileSync(join(scenarioDir, 'requirement.md'), 'utf8').trim(),
      source: `scenario:${manifest.id}`,
    },
  };
}

export interface RunHandle {
  runId: string;
  runDir: string;
  state: RunState;
  engine: WorkflowEngine;
  workspace: Workspace;
  params: RunParams;
}

export interface WiringOptions {
  approvalProvider?: ApprovalProvider | undefined;
  onEvent?: ((event: AuditEvent) => void) | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

/** Counts fired faults in a file in the run directory, so "fail once" still means once after a resume. */
function fileLedger(runDir: string): FaultLedger {
  const file = join(runDir, 'faults.json');
  const read = (): Record<string, number> => (existsSync(file) ? readJson<Record<string, number>>(file) : {});
  return {
    fired: (stageId) => read()[stageId] ?? 0,
    record: (stageId) => writeJsonAtomic(file, { ...read(), [stageId]: (read()[stageId] ?? 0) + 1 }),
  };
}

/** Live mode needs a key and an explicit model; nothing is defaulted, so a run never silently uses a model nobody chose. */
function liveGateway(environment: NodeJS.ProcessEnv): ModelGateway {
  const apiKey = environment.ANTHROPIC_API_KEY;
  const model = environment.SDLC_MODEL;
  if (!apiKey || !model) {
    throw new Error('Live mode needs ANTHROPIC_API_KEY and SDLC_MODEL (the model id to use) in the environment.');
  }
  return new AnthropicGateway({
    apiKey,
    model,
    ...(environment.ANTHROPIC_BASE_URL ? { baseUrl: environment.ANTHROPIC_BASE_URL } : {}),
  });
}

/** Builds the engine and everything it depends on for a run directory. Used for both new and resumed runs. */
function wire(runDir: string, state: RunState, options: WiringOptions): RunHandle {
  const params = state.params as unknown as RunParams;
  const environment = options.environment ?? process.env;
  const audit = new AuditLog(join(runDir, 'audit.jsonl'), state.runId);
  const workspace = new Workspace(runDir);

  // The engine is created after the gateways that report to it, so they reach it through this reference.
  let engine: WorkflowEngine | undefined;
  const metered = (gateway: ModelGateway): ModelGateway =>
    new MeteredGateway(gateway, (record) => {
      engine?.recordModelCall();
      const event = audit.append('MODEL_CALLED', { kind: 'tool', id: `model-gateway:${record.gateway}` }, { ...record }, record.stageId);
      options.onEvent?.(event);
    });

  const recordings = params.scenarioDir ? join(params.scenarioDir, 'recorded') : undefined;
  const recorded = recordings && existsSync(recordings) ? new RecordedGateway(recordings) : undefined;
  if (params.mode === 'offline' && !recorded) {
    throw new Error('Offline mode needs a scenario with recordings. Use --mode live for a requirement of your own.');
  }
  const primary = params.mode === 'live' ? liveGateway(environment) : recorded!;

  const deps: AgentDeps = {
    model: metered(primary),
    workspace,
    policy: defaultPolicyEngine(),
    commands: new CommandRunner(NODE_SERVICE_COMMANDS),
    runDir,
    targetDir: params.targetDir,
    facts: { approvals: () => state.approvals },
  };

  engine = new WorkflowEngine({
    runDir,
    workflow: sdlcWorkflow(deps, {
      maxReworks: params.maxReworks,
      faults: params.faults.map(parseFault),
      faultLedger: fileLedger(runDir),
      fallbackModel: recorded ? metered(recorded) : undefined,
    }),
    state,
    audit,
    limits: params.limits,
    stopRequested: () => existsSync(join(runDir, 'STOP')),
    humanInputArtifacts: { clarifications: ARTIFACT.clarifications, changeRequests: ARTIFACT.changeRequests },
    ...(options.approvalProvider ? { approvalProvider: options.approvalProvider } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  return { runId: state.runId, runDir, state, engine, workspace, params };
}

/** Creates a run: copies the target into a sandbox, indexes it, and records the requirement as the first artifact. */
export function createRun(
  runsDir: string,
  runId: string,
  params: RunParams,
  requirement: RequirementInput,
  options: WiringOptions = {},
): RunHandle {
  const runDir = resolve(runsDir, runId);
  if (existsSync(runDir)) throw new Error(`Run "${runId}" already exists.`);
  // Fail on a missing key or missing recordings before anything is written to disk.
  if (params.mode === 'live') liveGateway(options.environment ?? process.env);
  if (params.mode === 'offline' && !(params.scenarioDir && existsSync(join(params.scenarioDir, 'recorded')))) {
    throw new Error('Offline mode needs a scenario with recordings. Use --mode live for a requirement of your own.');
  }
  mkdirSync(runDir, { recursive: true });

  const now = new Date();
  const targetDir = resolve(params.targetDir);
  const state = newRunState(runId, 'sdlc', { ...params, targetDir } as unknown as Record<string, unknown>, now);

  const workspace = new Workspace(runDir);
  const baseline = workspace.initialize(targetDir);
  const audit = new AuditLog(join(runDir, 'audit.jsonl'), runId);
  audit.append('RUN_CREATED', ENGINE, {
    scenario: params.scenarioId,
    mode: params.mode,
    targetDir: displayPath(targetDir),
    baselineHash: baseline.treeHash,
    baselineFiles: Object.keys(baseline.files).length,
    limits: params.limits,
    faults: params.faults,
  });

  // The run's two starting artifacts: what was asked for, and what already exists.
  const store = new ArtifactStore(runDir, state);
  const at = now.toISOString();
  const seed = (name: string, content: unknown, actor: Actor): void => {
    const { version } = store.publish(name, content, {
      status: 'accepted',
      producedBy: { stageId: 'run-creation', generation: 0, attempt: 0, actor: actor.id },
      derivedFrom: {},
      at,
    });
    audit.append('ARTIFACT_PUBLISHED', actor, { name, version: version.version, hash: version.hash, status: 'accepted' });
  };
  seed(ARTIFACT.requirement, requirement, { kind: 'human', id: 'requester' });
  seed(ARTIFACT.baselineIndex, buildCodeIndex(workspace.baselineDir), ENGINE);
  writeJsonAtomic(join(runDir, 'state.json'), state);

  return wire(runDir, state, options);
}

export function openRun(runsDir: string, runId: string, options: WiringOptions = {}): RunHandle {
  const runDir = resolve(runsDir, runId);
  const stateFile = join(runDir, 'state.json');
  if (!existsSync(stateFile)) throw new Error(`No run "${runId}" in ${resolve(runsDir)}.`);
  return wire(runDir, readJson<RunState>(stateFile), options);
}
