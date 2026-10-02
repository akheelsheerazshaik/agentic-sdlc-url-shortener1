/**
 * The vocabulary of the orchestration engine.
 *
 * The engine knows nothing about software delivery. It runs a graph of stages, each of which
 * consumes and produces named artifacts, and it enforces the controls declared on each stage:
 * gates, approvals, retries, fallback, rework loops and compensation.
 */

// ---------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------

export interface Decision {
  decision: string;
  rationale: string;
  alternatives?: string[] | undefined;
}

export interface StageResult {
  /** Artifact name to content, for every artifact the stage declares in `produces`. */
  outputs: Record<string, unknown>;
  /** Choices the agent made that a reviewer should be able to trace later. */
  decisions?: Decision[] | undefined;
}

export interface StageContext {
  runId: string;
  stageId: string;
  /**
   * How many distinct sets of inputs this stage has been run with. It goes up when an upstream
   * artifact changes (re-plan, rework), and stays the same across retries of the same inputs.
   */
  generation: number;
  /** 1-based attempt number within the current agent (primary or fallback). */
  attempt: number;
  usingFallback: boolean;
  /** Latest accepted content of each consumed artifact; optional inputs are absent until published. */
  inputs: Record<string, unknown>;
  /** Why the previous attempt was rejected, when this is a retry after a failed exit gate. */
  feedback: string[];
  /** Aborted on timeout, operator stop, or a fatal failure elsewhere in the run. */
  signal: AbortSignal;
}

export interface Agent {
  id: string;
  run(context: StageContext): Promise<StageResult>;
}

/**
 * Thrown by agents and gates. `retryable: false` means trying the same agent again cannot help,
 * so the engine skips its remaining attempts. A fallback agent, if the stage has one, still runs.
 */
export class StageFailure extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean } = { retryable: true }) {
    super(message);
    this.name = 'StageFailure';
    this.retryable = options.retryable;
  }
}

// ---------------------------------------------------------------------------------------------
// Controls declared on a stage
// ---------------------------------------------------------------------------------------------

export interface GateInput {
  inputs: Record<string, unknown>;
  /** Present for exit gates only. */
  outputs?: Record<string, unknown> | undefined;
}

export interface GateOutcome {
  passed: boolean;
  /** What was checked when it passed; what is wrong when it failed. */
  details: string[];
}

export interface Gate {
  id: string;
  description: string;
  check(input: GateInput): GateOutcome | Promise<GateOutcome>;
}

export interface ApprovalNeed {
  /** `approval` asks for sign-off; `clarification` asks the human for answers the run cannot proceed without. */
  kind: 'approval' | 'clarification';
  reasons: string[];
}

export interface ApprovalRule {
  /** `before`: sign off on the action before it runs. `after`: sign off on what the stage produced. */
  phase: 'before' | 'after';
  /** Returns null when this particular execution is low-risk enough to proceed without a human. */
  required(input: GateInput): ApprovalNeed | null;
}

export interface RetryPolicy {
  maxAttempts: number;
  /** Delay before the second attempt; doubles for each attempt after that. */
  backoffMs: number;
}

export interface ReworkPolicy {
  /** Artifact published when the exit gate fails. An upstream stage must consume it. */
  feedbackArtifact: string;
  /** How many times this stage may send work back before the run is stopped. */
  max: number;
}

export interface StageDefinition {
  id: string;
  title: string;
  dependsOn: string[];
  consumes: string[];
  consumesOptional?: string[];
  produces: string[];
  agent: Agent;
  /** Used once after the primary agent has exhausted its attempts. */
  fallback?: Agent;
  entryGates?: Gate[];
  exitGates?: Gate[];
  approval?: ApprovalRule;
  retry?: RetryPolicy;
  rework?: ReworkPolicy;
  timeoutMs?: number;
  /** A stage that is not enabled for this run is skipped and counts as settled. */
  enabled?: (inputs: Record<string, unknown>) => boolean;
  /** Undoes this stage's side effects. Declared only by stages that change something outside the run's artifacts. */
  compensate?: () => Promise<void>;
}

export interface WorkflowDefinition {
  id: string;
  stages: StageDefinition[];
}

// ---------------------------------------------------------------------------------------------
// Persisted run state
// ---------------------------------------------------------------------------------------------

export type StageStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'SUCCEEDED'
  | 'SKIPPED'
  | 'FAILED'
  | 'ROLLED_BACK';

export type RunStatus = 'CREATED' | 'RUNNING' | 'PAUSED' | 'SUCCEEDED' | 'SAFE_STOPPED';

export interface PendingApproval {
  phase: 'before' | 'after';
  kind: 'approval' | 'clarification';
  /** Hash of exactly what is being approved: the inputs (before) or the outputs (after). */
  subjectHash: string;
  reasons: string[];
  requestedAt: string;
}

export interface StageState {
  status: StageStatus;
  generation: number;
  attempts: number;
  reworksTriggered: number;
  /** Fingerprint of the inputs the stage last ran with. */
  inputFingerprint?: string | undefined;
  /** Hash of each input artifact the stage last ran with, to report which ones changed. */
  inputHashes?: Record<string, string> | undefined;
  pendingApproval?: PendingApproval | undefined;
  /** An ancestor was reset; once the ancestors settle, this stage is re-run or reused. */
  needsRevalidation?: boolean | undefined;
  /** The stage started an action that `compensate` knows how to undo. */
  sideEffects?: boolean | undefined;
  usedFallback?: boolean | undefined;
  lastError?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
}

export type ArtifactStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded';

export interface ArtifactVersion {
  name: string;
  version: number;
  hash: string;
  status: ArtifactStatus;
  producedBy: { stageId: string; generation: number; attempt: number; actor: string };
  /** Hashes of the artifacts this one was derived from: the lineage edge. */
  derivedFrom: Record<string, string>;
  /**
   * Later executions that produced exactly this content again from different inputs. The version
   * is reused rather than duplicated, and the newer derivation is recorded here.
   */
  reaffirmations?: { derivedFrom: Record<string, string>; generation: number; at: string }[];
  createdAt: string;
  file: string;
}

export interface ApprovalRecord {
  stageId: string;
  phase: 'before' | 'after';
  subjectHash: string;
  decision: 'approved' | 'rejected' | 'changes_requested' | 'clarified';
  approver: string;
  /** How the decision reached the engine. `scripted` marks demo and test stand-ins for a person. */
  channel: 'cli' | 'interactive' | 'scripted';
  comment: string;
  at: string;
}

export interface DecisionRecord extends Decision {
  stageId: string;
  generation: number;
  /** Fingerprint of the inputs the decision was based on. */
  basedOn: string;
  at: string;
}

export interface BudgetLimits {
  /** Hard cap on agent invocations in one run, including retries and re-plans. */
  maxStageExecutions: number;
  maxModelCalls: number;
  /** Cap on time spent executing; time spent waiting for a human does not count. */
  maxActiveMs: number;
}

export interface RunState {
  runId: string;
  workflowId: string;
  status: RunStatus;
  stopReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
  stages: Record<string, StageState>;
  artifacts: Record<string, ArtifactVersion[]>;
  approvals: ApprovalRecord[];
  decisions: DecisionRecord[];
  usage: { stageExecutions: number; modelCalls: number; activeMs: number };
  /** Free-form run parameters the engine does not interpret (scenario, target directory, mode). */
  params: Record<string, unknown>;
}
