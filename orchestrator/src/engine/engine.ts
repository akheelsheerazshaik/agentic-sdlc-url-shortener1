import { join } from 'node:path';
import { ENGINE, type Actor, type AuditEvent, type AuditLog } from '../governance/audit.ts';
import { writeJsonAtomic } from '../util/fsx.ts';
import { hashOf } from '../util/hash.ts';
import { ArtifactStore } from './artifacts.ts';
import { WorkflowGraph } from './graph.ts';
import {
  StageFailure,
  type ApprovalNeed,
  type ApprovalRecord,
  type BudgetLimits,
  type Gate,
  type GateInput,
  type RunState,
  type StageContext,
  type StageDefinition,
  type StageResult,
  type StageState,
  type WorkflowDefinition,
} from './types.ts';

/** What a person is being asked to decide. */
export interface ApprovalRequest {
  runId: string;
  stageId: string;
  title: string;
  phase: 'before' | 'after';
  kind: 'approval' | 'clarification';
  reasons: string[];
  subjectHash: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown> | undefined;
}

export type HumanDecision =
  | { decision: 'approved'; approver: string; comment?: string }
  | { decision: 'rejected'; approver: string; comment: string }
  | { decision: 'changes_requested'; approver: string; comment: string }
  | { decision: 'clarified'; approver: string; answers: Record<string, string>; comment?: string };

export type DecisionChannel = ApprovalRecord['channel'];

/**
 * Asks a person for a decision while the run is live. Returning null leaves the stage waiting,
 * and the run pauses once nothing else can make progress.
 */
export type ApprovalProvider = (
  request: ApprovalRequest,
) => Promise<{ decision: HumanDecision; channel: DecisionChannel } | null>;

export interface EngineOptions {
  runDir: string;
  workflow: WorkflowDefinition;
  state: RunState;
  audit: AuditLog;
  limits: BudgetLimits;
  approvalProvider?: ApprovalProvider;
  /** Polled between scheduling steps: the operator's kill switch. */
  stopRequested?: () => boolean;
  /** Names of the artifacts that carry human input back into the graph. */
  humanInputArtifacts?: { clarifications: string; changeRequests: string };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: AuditEvent) => void;
}

const REWORK = Symbol('rework');
const DEFAULT_RETRY = { maxAttempts: 2, backoffMs: 200 };
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface Fatal {
  reason: string;
  /** `all`: undo every side effect of the run. `interrupted`: undo only actions cut off mid-flight. */
  rollback: 'all' | 'interrupted';
}

/**
 * Stateful scheduler for a workflow graph.
 *
 * On every step it re-derives what can run from the persisted state: it resets stages whose
 * inputs changed, starts every stage whose dependencies are settled, and waits for any of them to
 * finish. Because the state is saved after each transition, a run can pause for a human, exit,
 * and continue later in a new process from exactly where it stopped.
 */
export class WorkflowEngine {
  readonly graph: WorkflowGraph;
  readonly artifacts: ArtifactStore;
  private readonly options: EngineOptions;
  private readonly state: RunState;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abortController = new AbortController();
  private readonly agentIds: Set<string>;
  private readonly humanInputs: { clarifications: string; changeRequests: string };
  private fatal: Fatal | undefined;
  private activeSince: number | undefined;

  constructor(options: EngineOptions) {
    this.options = options;
    this.state = options.state;
    this.graph = new WorkflowGraph(options.workflow);
    this.artifacts = new ArtifactStore(options.runDir, options.state);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.humanInputs = options.humanInputArtifacts ?? {
      clarifications: 'clarifications',
      changeRequests: 'change-requests',
    };
    this.agentIds = new Set(
      this.graph.stages.flatMap((stage) => [stage.agent.id, ...(stage.fallback ? [stage.fallback.id] : [])]),
    );
    for (const stage of this.graph.stages) {
      this.state.stages[stage.id] ??= { status: 'PENDING', generation: 0, attempts: 0, reworksTriggered: 0 };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Scheduling loop
  // -------------------------------------------------------------------------------------------

  async run(): Promise<RunState> {
    const state = this.state;
    // A finished run stays finished, and a stopped run stays stopped until a person authorizes a retry.
    if (state.status === 'SUCCEEDED' || state.status === 'SAFE_STOPPED') return state;

    this.emit(state.status === 'CREATED' ? 'RUN_STARTED' : 'RUN_RESUMED', ENGINE, { previousStatus: state.status });
    const pendingStop = state.stopReason !== undefined && state.status === 'PAUSED' ? state.stopReason : undefined;
    state.status = 'RUNNING';
    state.stopReason = undefined;
    this.activeSince = this.now().getTime();
    await this.recoverInterruptedStages();
    if (pendingStop) this.fatal ??= { reason: pendingStop, rollback: 'all' };

    for (;;) {
      if (!this.fatal) this.checkStopConditions();
      if (this.fatal) {
        await this.safeStop(this.fatal);
        break;
      }

      this.invalidateStaleStages();
      for (const stage of this.readyStages()) this.launch(stage);

      if (this.inFlight.size === 0) {
        if (this.graph.stages.every((stage) => this.isSettled(stage.id))) {
          state.status = 'SUCCEEDED';
          this.emit('RUN_SUCCEEDED', ENGINE, { usage: this.usageSnapshot() });
          break;
        }
        const waiting = this.graph.stages.filter((stage) => this.stageState(stage.id).status === 'AWAITING_APPROVAL');
        if (waiting.length > 0) {
          state.status = 'PAUSED';
          this.emit('RUN_PAUSED', ENGINE, { waitingOn: waiting.map((stage) => stage.id) });
          break;
        }
        this.fatal = { reason: 'No stage can run and none is waiting on a person: the run is stuck.', rollback: 'all' };
        continue;
      }
      await Promise.race(this.inFlight.values());
    }

    this.stopClock();
    this.save();
    return state;
  }

  private checkStopConditions(): void {
    if (this.options.stopRequested?.()) {
      this.emit('STOP_REQUESTED', { kind: 'human', id: 'operator' }, {});
      this.fatal = { reason: 'Stopped by the operator.', rollback: 'interrupted' };
      return;
    }
    const { limits } = this.options;
    const usage = this.usageSnapshot();
    const exceeded =
      usage.stageExecutions >= limits.maxStageExecutions
        ? `stage executions (${usage.stageExecutions}/${limits.maxStageExecutions})`
        : usage.modelCalls > limits.maxModelCalls
          ? `model calls (${usage.modelCalls}/${limits.maxModelCalls})`
          : usage.activeMs > limits.maxActiveMs
            ? `active time (${Math.round(usage.activeMs / 1000)}s/${Math.round(limits.maxActiveMs / 1000)}s)`
            : undefined;
    // Only stop on the budget when there is still work to start; a run that is finishing may finish.
    if (exceeded && this.readyStages().length > 0) {
      this.emit('BUDGET_EXCEEDED', ENGINE, { exceeded, usage });
      this.fatal = { reason: `Autonomy budget exceeded: ${exceeded}.`, rollback: 'interrupted' };
    }
  }

  /**
   * A stage left RUNNING by a process that died is run again. If it had started an action with
   * side effects, that action may be half done, so it is undone first: re-running on top of a
   * half-finished change would treat the damage as the starting point.
   */
  private async recoverInterruptedStages(): Promise<void> {
    for (const stage of this.graph.stages) {
      const stageState = this.stageState(stage.id);
      if (stageState.status !== 'RUNNING') continue;

      if (stage.compensate && stageState.sideEffects) {
        try {
          await stage.compensate();
          stageState.sideEffects = false;
          this.emit('COMPENSATION_EXECUTED', ENGINE, { reason: 'undoing an action interrupted by a crash' }, stage.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit('COMPENSATION_FAILED', ENGINE, { error: message }, stage.id);
          stageState.status = 'FAILED';
          stageState.lastError = `could not undo the interrupted action: ${message}`;
          this.fatal = { reason: `Stage "${stage.id}" was interrupted and could not be undone: ${message}`, rollback: 'interrupted' };
          continue;
        }
      }
      stageState.status = 'PENDING';
      this.emit('STAGE_RECOVERED', ENGINE, { reason: 'found RUNNING at startup; the previous process did not finish it' }, stage.id);
    }
  }

  /** Settled means finished, and built on ancestors that are themselves all finished. */
  private isSettled(stageId: string): boolean {
    const status = this.stageState(stageId).status;
    if (status !== 'SUCCEEDED' && status !== 'SKIPPED') return false;
    return this.graph.stage(stageId).dependsOn.every((dependency) => this.isSettled(dependency));
  }

  private upstreamSettled(stage: StageDefinition): boolean {
    return stage.dependsOn.every((dependency) => this.isSettled(dependency));
  }

  private readyStages(): StageDefinition[] {
    return this.graph.stages.filter(
      (stage) =>
        this.stageState(stage.id).status === 'PENDING' && !this.inFlight.has(stage.id) && this.upstreamSettled(stage),
    );
  }

  /**
   * Re-planning. A finished stage whose inputs now hash differently is reset, in dependency order.
   * A stage whose ancestor was re-run but whose own inputs came out identical is kept: its earlier
   * result is still valid, so nothing downstream of it re-runs either.
   */
  private invalidateStaleStages(): void {
    for (const stage of this.graph.stages) {
      const stageState = this.stageState(stage.id);
      const finished =
        stageState.status === 'SUCCEEDED' || stageState.status === 'SKIPPED' || stageState.status === 'AWAITING_APPROVAL';
      if (!finished || !this.upstreamSettled(stage)) continue;

      const fingerprint = this.fingerprint(stage);
      if (stageState.inputFingerprint !== fingerprint) {
        const changedInputs = this.changedInputs(stage);
        this.resetStage(stage, 'inputs changed', { changedInputs });
        this.emit('STAGE_INVALIDATED', ENGINE, { reason: 'inputs changed', changedInputs }, stage.id);
      } else if (stageState.needsRevalidation) {
        stageState.needsRevalidation = false;
        this.emit('STAGE_REUSED', ENGINE, { reason: 'upstream re-ran but this stage\'s inputs are unchanged' }, stage.id);
      }
    }
  }

  private resetStage(stage: StageDefinition, reason: string, data: Record<string, unknown> = {}): void {
    const stageState = this.stageState(stage.id);
    if (stageState.pendingApproval) {
      // The request was for content that no longer exists, so it cannot be approved any more.
      for (const name of stage.produces) this.artifacts.setStatus(name, 'proposed', 'superseded', stage.id);
      this.emit('APPROVAL_VOIDED', ENGINE, { reason, ...data }, stage.id);
    }
    stageState.status = 'PENDING';
    stageState.pendingApproval = undefined;
    stageState.needsRevalidation = false;
    for (const descendant of this.graph.descendants(stage.id)) {
      const descendantState = this.stageState(descendant);
      if (descendantState.status === 'SUCCEEDED' || descendantState.status === 'AWAITING_APPROVAL') {
        descendantState.needsRevalidation = true;
      }
    }
  }

  private launch(stage: StageDefinition): void {
    this.stageState(stage.id).status = 'RUNNING';
    const execution = this.executeStage(stage).finally(() => {
      this.inFlight.delete(stage.id);
      this.save();
    });
    this.inFlight.set(stage.id, execution);
  }

  // -------------------------------------------------------------------------------------------
  // One stage
  // -------------------------------------------------------------------------------------------

  private async executeStage(stage: StageDefinition): Promise<void> {
    const stageState = this.stageState(stage.id);
    try {
      const inputs = this.readInputs(stage);
      if (stage.enabled && !stage.enabled(inputs)) {
        stageState.status = 'SKIPPED';
        stageState.inputFingerprint = this.fingerprint(stage);
        stageState.inputHashes = this.inputHashes(stage);
        this.emit('STAGE_SKIPPED', ENGINE, { reason: 'not enabled for this run' }, stage.id);
        return;
      }

      const fingerprint = this.fingerprint(stage);
      if (stageState.inputFingerprint !== fingerprint) {
        stageState.generation += 1;
        stageState.inputFingerprint = fingerprint;
      }
      stageState.inputHashes = this.inputHashes(stage);
      stageState.startedAt = this.now().toISOString();
      stageState.lastError = undefined;
      this.save();

      await this.requireGates('entry', stage, { inputs });

      if (stage.approval?.phase === 'before') {
        const need = stage.approval.required({ inputs });
        if (need && !(await this.obtainApproval(stage, 'before', fingerprint, need, inputs))) return;
        stageState.status = 'RUNNING';
      }

      const result = await this.runWithRecovery(stage, inputs, fingerprint);
      if (result === REWORK) return;

      if (this.fingerprint(stage) !== fingerprint) {
        // An input changed while the stage was running, so its result describes a world that is gone.
        stageState.status = 'PENDING';
        this.emit('STAGE_INVALIDATED', ENGINE, { reason: 'inputs changed during execution' }, stage.id);
        return;
      }

      const need = stage.approval?.phase === 'after' ? stage.approval.required({ inputs, outputs: result.outputs }) : null;
      const outputHash = hashOf(result.outputs);
      const alreadyApproved = need !== null && this.findApproval(stage.id, 'after', outputHash) !== undefined;
      this.publishOutputs(stage, result, need !== null && !alreadyApproved ? 'proposed' : 'accepted');

      if (need && !alreadyApproved) {
        if (!(await this.obtainApproval(stage, 'after', outputHash, need, inputs, result.outputs))) return;
      }
      this.markSucceeded(stage);
    } catch (error) {
      if (this.abortController.signal.aborted && !this.fatalCausedBy(error)) {
        // Cut off by a stop elsewhere in the run. Leave it to be re-run on resume.
        stageState.status = 'PENDING';
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      stageState.status = 'FAILED';
      stageState.lastError = message;
      stageState.finishedAt = this.now().toISOString();
      this.emit('STAGE_FAILED', ENGINE, { error: message }, stage.id);
      this.fatal ??= { reason: `Stage "${stage.id}" failed: ${message}`, rollback: 'all' };
      this.abortController.abort();
    }
  }

  private fatalCausedBy(error: unknown): boolean {
    return error instanceof StageFailure && !error.retryable;
  }

  /**
   * Runs the stage's agent under its recovery policy, in this order:
   * bounded retries with backoff, then the fallback agent, then (if the exit gate still fails and
   * the stage declares it) a bounded rework loop that sends feedback upstream. Anything left is fatal.
   */
  private async runWithRecovery(
    stage: StageDefinition,
    inputs: Record<string, unknown>,
    fingerprint: string,
  ): Promise<StageResult | typeof REWORK> {
    const stageState = this.stageState(stage.id);
    const retry = stage.retry ?? DEFAULT_RETRY;
    const steps = [
      { agent: stage.agent, attempts: retry.maxAttempts, fallback: false },
      ...(stage.fallback ? [{ agent: stage.fallback, attempts: 1, fallback: true }] : []),
    ];

    let feedback: string[] = [];
    let lastError: Error = new Error('stage did not run');
    stageState.usedFallback = false;

    for (const step of steps) {
      if (step.fallback) {
        stageState.usedFallback = true;
        this.emit('FALLBACK_ACTIVATED', ENGINE, { from: stage.agent.id, to: step.agent.id, after: lastError.message }, stage.id);
      }
      for (let attempt = 1; attempt <= step.attempts; attempt++) {
        if (this.abortController.signal.aborted) throw new Error('run is stopping');
        this.state.usage.stageExecutions += 1;
        stageState.attempts += 1;
        if (stage.compensate) stageState.sideEffects = true;

        const actor: Actor = { kind: 'agent', id: step.agent.id };
        this.emit(
          'STAGE_STARTED',
          actor,
          { generation: stageState.generation, attempt, fallback: step.fallback, inputFingerprint: fingerprint, inputs: this.inputHashes(stage) },
          stage.id,
        );
        this.save();

        try {
          const result = await this.invoke(stage, step.agent, {
            runId: this.state.runId,
            stageId: stage.id,
            generation: stageState.generation,
            attempt,
            usingFallback: step.fallback,
            inputs,
            feedback,
          });
          const failures = await this.evaluateGates('exit', stage, { inputs, outputs: result.outputs });
          if (failures.length === 0) {
            this.recordDecisions(stage, result, fingerprint, actor);
            return result;
          }
          if (stage.rework) return this.requestRework(stage, result, failures);
          feedback = failures;
          throw new StageFailure(`exit gate failed: ${failures.join(' | ')}`);
        } catch (error) {
          if (this.abortController.signal.aborted) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));
          const retryable = !(lastError instanceof StageFailure) || lastError.retryable;
          const willRetry = retryable && attempt < step.attempts;
          this.emit('STAGE_ATTEMPT_FAILED', actor, { attempt, error: lastError.message, retryable, willRetry }, stage.id);
          if (!willRetry) break;
          await this.sleep(retry.backoffMs * 2 ** (attempt - 1));
        }
      }
    }
    throw new StageFailure(`all attempts failed. Last error: ${lastError.message}`, { retryable: false });
  }

  private async invoke(
    stage: StageDefinition,
    agent: StageDefinition['agent'],
    context: Omit<StageContext, 'signal'>,
  ): Promise<StageResult> {
    const timeoutMs = stage.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attemptAbort = new AbortController();
    const onRunAbort = (): void => attemptAbort.abort();
    this.abortController.signal.addEventListener('abort', onRunAbort, { once: true });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        attemptAbort.abort();
        reject(new StageFailure(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([agent.run({ ...context, signal: attemptAbort.signal }), timeout]);
    } finally {
      clearTimeout(timer);
      this.abortController.signal.removeEventListener('abort', onRunAbort);
    }
  }

  /** The exit gate failed and the stage can send work back. Publishes the feedback an upstream stage will consume. */
  private requestRework(stage: StageDefinition, result: StageResult, failures: string[]): typeof REWORK {
    const stageState = this.stageState(stage.id);
    const policy = stage.rework!;
    // Keep what was rejected: it is the evidence for why the work went back.
    this.publishOutputs(stage, result, 'rejected');

    if (stageState.reworksTriggered >= policy.max) {
      throw new StageFailure(
        `still failing after ${policy.max} rework loop(s): ${failures.join(' | ')}`,
        { retryable: false },
      );
    }
    stageState.reworksTriggered += 1;
    const { version } = this.artifacts.publish(
      policy.feedbackArtifact,
      { fromStage: stage.id, iteration: stageState.reworksTriggered, failures, rejected: result.outputs },
      {
        status: 'accepted',
        producedBy: { stageId: stage.id, generation: stageState.generation, attempt: stageState.attempts, actor: ENGINE.id },
        derivedFrom: this.inputHashes(stage),
        at: this.now().toISOString(),
      },
    );
    this.emit(
      'REWORK_REQUESTED',
      ENGINE,
      { iteration: stageState.reworksTriggered, max: policy.max, feedbackArtifact: policy.feedbackArtifact, feedbackVersion: version.version, failures },
      stage.id,
    );
    stageState.status = 'PENDING';
    return REWORK;
  }

  // -------------------------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------------------------

  private async evaluateGates(kind: 'entry' | 'exit', stage: StageDefinition, input: GateInput): Promise<string[]> {
    const gates: Gate[] = (kind === 'entry' ? stage.entryGates : stage.exitGates) ?? [];
    const failures: string[] = [];
    for (const gate of gates) {
      const outcome = await gate.check(input);
      this.emit('GATE_EVALUATED', { kind: 'policy', id: gate.id }, { kind, passed: outcome.passed, details: outcome.details }, stage.id);
      if (!outcome.passed) failures.push(...outcome.details.map((detail) => `[${gate.id}] ${detail}`));
    }
    return failures;
  }

  private async requireGates(kind: 'entry', stage: StageDefinition, input: GateInput): Promise<void> {
    for (const name of stage.consumes) {
      if (!this.artifacts.latest(name)) {
        throw new StageFailure(`required input "${name}" is missing`, { retryable: false });
      }
    }
    const failures = await this.evaluateGates(kind, stage, input);
    if (failures.length > 0) {
      throw new StageFailure(`${kind} gate failed: ${failures.join(' | ')}`, { retryable: false });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Human decisions
  // -------------------------------------------------------------------------------------------

  private findApproval(stageId: string, phase: 'before' | 'after', subjectHash: string): ApprovalRecord | undefined {
    return this.state.approvals.find(
      (record) =>
        record.stageId === stageId &&
        record.phase === phase &&
        record.subjectHash === subjectHash &&
        record.decision === 'approved',
    );
  }

  /** Returns true when execution may continue. Otherwise the stage is waiting, was sent back, or was rejected. */
  private async obtainApproval(
    stage: StageDefinition,
    phase: 'before' | 'after',
    subjectHash: string,
    need: ApprovalNeed,
    inputs: Record<string, unknown>,
    outputs?: Record<string, unknown>,
  ): Promise<boolean> {
    // An approval covers exactly the content that was hashed. If that content is back, so is the approval.
    if (this.findApproval(stage.id, phase, subjectHash)) return true;

    const stageState = this.stageState(stage.id);
    stageState.status = 'AWAITING_APPROVAL';
    stageState.pendingApproval = {
      phase,
      kind: need.kind,
      subjectHash,
      reasons: need.reasons,
      requestedAt: this.now().toISOString(),
    };
    this.emit('APPROVAL_REQUESTED', ENGINE, { phase, kind: need.kind, subjectHash, reasons: need.reasons }, stage.id);
    this.save();

    if (!this.options.approvalProvider) return false;
    const answer = await this.options.approvalProvider({
      runId: this.state.runId,
      stageId: stage.id,
      title: stage.title,
      phase,
      kind: need.kind,
      reasons: need.reasons,
      subjectHash,
      inputs,
      outputs,
    });
    if (!answer) return false;
    this.submitDecision(stage.id, answer.decision, answer.channel);
    return answer.decision.decision === 'approved' && phase === 'before';
  }

  /**
   * Records a person's decision on a waiting stage and moves the stage accordingly.
   * Called by the approval provider while a run is live, and by the CLI while it is paused.
   */
  submitDecision(stageId: string, decision: HumanDecision, channel: DecisionChannel): void {
    const stage = this.graph.stage(stageId);
    const stageState = this.stageState(stageId);
    const pending = stageState.pendingApproval;
    if (stageState.status !== 'AWAITING_APPROVAL' || !pending) {
      throw new Error(`Stage "${stageId}" is not waiting for a decision.`);
    }
    this.assertHumanApprover(decision.approver);
    if (decision.decision === 'clarified' && pending.kind !== 'clarification') {
      throw new Error(`Stage "${stageId}" is waiting for an approval, not for clarification.`);
    }
    if ((decision.decision === 'rejected' || decision.decision === 'changes_requested') && !decision.comment.trim()) {
      throw new Error('A rejection or change request needs a comment explaining why.');
    }

    const at = this.now().toISOString();
    const human: Actor = { kind: 'human', id: decision.approver };
    const record: ApprovalRecord = {
      stageId,
      phase: pending.phase,
      subjectHash: pending.subjectHash,
      decision: decision.decision,
      approver: decision.approver,
      channel,
      comment: decision.comment ?? '',
      at,
    };
    this.state.approvals.push(record);
    this.emit('APPROVAL_RECORDED', human, { ...record }, stageId);
    stageState.pendingApproval = undefined;

    const humanProvenance = { stageId, generation: stageState.generation, attempt: stageState.attempts, actor: decision.approver };

    switch (decision.decision) {
      case 'approved':
        if (pending.phase === 'after') {
          for (const name of stage.produces) {
            for (const version of this.artifacts.setStatus(name, 'proposed', 'accepted', stageId)) {
              this.emit('ARTIFACT_ACCEPTED', human, { name, version: version.version, hash: version.hash }, stageId);
            }
          }
          this.markSucceeded(stage);
        } else {
          stageState.status = 'PENDING';
        }
        break;

      case 'rejected':
        for (const name of stage.produces) this.artifacts.setStatus(name, 'proposed', 'rejected', stageId);
        stageState.status = 'FAILED';
        stageState.lastError = `rejected by ${decision.approver}: ${decision.comment}`;
        this.requestFatalStop(`Stage "${stageId}" was rejected by ${decision.approver}: ${decision.comment}`);
        break;

      case 'changes_requested': {
        for (const name of stage.produces) this.artifacts.setStatus(name, 'proposed', 'rejected', stageId);
        const name = this.humanInputs.changeRequests;
        const existing = this.artifacts.content<{ requests: unknown[] }>(name)?.requests ?? [];
        const { version } = this.artifacts.publish(
          name,
          { requests: [...existing, { raisedAt: stageId, by: decision.approver, request: decision.comment, at }] },
          { status: 'accepted', producedBy: humanProvenance, derivedFrom: {}, at },
        );
        this.emit('HUMAN_INPUT_RECORDED', human, { artifact: name, version: version.version, kind: 'change-request' }, stageId);
        this.resetStage(stage, 'changes requested');
        break;
      }

      case 'clarified': {
        const name = this.humanInputs.clarifications;
        const existing = this.artifacts.content<{ answers: Record<string, string> }>(name)?.answers ?? {};
        const { version } = this.artifacts.publish(
          name,
          { answers: { ...existing, ...decision.answers }, by: decision.approver },
          { status: 'accepted', producedBy: humanProvenance, derivedFrom: {}, at },
        );
        for (const produced of stage.produces) this.artifacts.setStatus(produced, 'proposed', 'superseded', stageId);
        this.emit('HUMAN_INPUT_RECORDED', human, { artifact: name, version: version.version, kind: 'clarification' }, stageId);
        this.resetStage(stage, 'clarification received');
        break;
      }
    }
    this.save();
  }

  /** Separation of duties: the identities that do the work may not also sign it off. */
  private assertHumanApprover(approver: string): void {
    const name = approver.trim();
    if (name === '') throw new Error('An approver identity is required.');
    if (this.agentIds.has(name) || name === ENGINE.id || /^(agent|engine|policy|tool|model)\b/i.test(name)) {
      throw new Error(`"${name}" is not a person. Approvals must come from a human, not from an agent or the engine.`);
    }
  }

  /** While the loop is live this stops it now; while paused it is picked up by the next `run()`. */
  private requestFatalStop(reason: string): void {
    if (this.activeSince !== undefined) {
      this.fatal ??= { reason, rollback: 'all' };
      this.abortController.abort();
    } else {
      this.state.stopReason = reason;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Stopping safely
  // -------------------------------------------------------------------------------------------

  private async safeStop(fatal: Fatal): Promise<void> {
    this.abortController.abort();
    await Promise.allSettled(this.inFlight.values());

    const toUndo = [...this.graph.stages].reverse().filter((stage) => {
      const stageState = this.stageState(stage.id);
      if (!stage.compensate || !stageState.sideEffects) return false;
      return fatal.rollback === 'all' || stageState.status !== 'SUCCEEDED';
    });

    const rolledBack: string[] = [];
    const rollbackFailures: string[] = [];
    if (toUndo.length > 0) this.emit('ROLLBACK_STARTED', ENGINE, { stages: toUndo.map((stage) => stage.id), scope: fatal.rollback });
    for (const stage of toUndo) {
      const stageState = this.stageState(stage.id);
      try {
        await stage.compensate!();
        stageState.sideEffects = false;
        if (stageState.status !== 'FAILED') stageState.status = 'ROLLED_BACK';
        rolledBack.push(stage.id);
        this.emit('COMPENSATION_EXECUTED', ENGINE, {}, stage.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rollbackFailures.push(`${stage.id}: ${message}`);
        this.emit('COMPENSATION_FAILED', ENGINE, { error: message }, stage.id);
      }
    }

    this.state.status = 'SAFE_STOPPED';
    this.state.stopReason =
      rollbackFailures.length > 0
        ? `${fatal.reason} ROLLBACK INCOMPLETE, manual action needed: ${rollbackFailures.join('; ')}`
        : fatal.reason;
    this.emit('RUN_SAFE_STOPPED', ENGINE, { reason: fatal.reason, rolledBack, rollbackFailures, usage: this.usageSnapshot() });
  }

  /**
   * Makes a safely stopped run runnable again after a person has dealt with the cause.
   * Failed and rolled-back stages go back to PENDING; rework counters start over.
   */
  prepareRetry(operator: string): void {
    this.assertHumanApprover(operator);
    if (this.state.status !== 'SAFE_STOPPED') throw new Error('Only a safely stopped run can be retried.');
    const reset: string[] = [];
    for (const stage of this.graph.stages) {
      const stageState = this.stageState(stage.id);
      if (stageState.status === 'FAILED' || stageState.status === 'ROLLED_BACK') {
        // Same bookkeeping as any other reset: stages downstream are re-checked once this one has
        // run again, and are reused if their inputs come out the same.
        this.resetStage(stage, 'retry authorized');
        stageState.reworksTriggered = 0;
        stageState.lastError = undefined;
        reset.push(stage.id);
      }
    }
    this.state.status = 'PAUSED';
    this.state.stopReason = undefined;
    this.emit('RETRY_AUTHORIZED', { kind: 'human', id: operator }, { reset });
    this.save();
  }

  // -------------------------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------------------------

  private markSucceeded(stage: StageDefinition): void {
    const stageState = this.stageState(stage.id);
    stageState.status = 'SUCCEEDED';
    stageState.needsRevalidation = false;
    stageState.finishedAt = this.now().toISOString();
    this.emit('STAGE_SUCCEEDED', ENGINE, { generation: stageState.generation, attempts: stageState.attempts }, stage.id);
  }

  private publishOutputs(stage: StageDefinition, result: StageResult, status: 'proposed' | 'accepted' | 'rejected'): void {
    const stageState = this.stageState(stage.id);
    const actorId = stageState.usedFallback && stage.fallback ? stage.fallback.id : stage.agent.id;
    for (const name of stage.produces) {
      if (!(name in result.outputs)) {
        throw new StageFailure(`agent did not produce the declared artifact "${name}"`, { retryable: false });
      }
      const { version, created } = this.artifacts.publish(name, result.outputs[name], {
        status,
        producedBy: { stageId: stage.id, generation: stageState.generation, attempt: stageState.attempts, actor: actorId },
        derivedFrom: this.inputHashes(stage),
        at: this.now().toISOString(),
      });
      this.emit(
        created ? 'ARTIFACT_PUBLISHED' : 'ARTIFACT_UNCHANGED',
        { kind: 'agent', id: actorId },
        { name, version: version.version, hash: version.hash, status: version.status, derivedFrom: version.derivedFrom },
        stage.id,
      );
    }
  }

  private recordDecisions(stage: StageDefinition, result: StageResult, fingerprint: string, actor: Actor): void {
    const stageState = this.stageState(stage.id);
    for (const decision of result.decisions ?? []) {
      this.state.decisions.push({
        ...decision,
        stageId: stage.id,
        generation: stageState.generation,
        basedOn: fingerprint,
        at: this.now().toISOString(),
      });
      this.emit('DECISION_RECORDED', actor, { ...decision, basedOn: fingerprint }, stage.id);
    }
  }

  private readInputs(stage: StageDefinition): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const name of [...stage.consumes, ...(stage.consumesOptional ?? [])]) {
      const version = this.artifacts.latest(name);
      if (version) inputs[name] = this.artifacts.read(version);
    }
    return inputs;
  }

  /** Hash of each consumed artifact's current accepted version. */
  private inputHashes(stage: StageDefinition): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const name of [...stage.consumes, ...(stage.consumesOptional ?? [])]) {
      const version = this.artifacts.latest(name);
      if (version) hashes[name] = version.hash;
    }
    return hashes;
  }

  /** One hash over all of a stage's inputs. Equal fingerprints mean the stage would see the same world. */
  private fingerprint(stage: StageDefinition): string {
    return hashOf(this.inputHashes(stage));
  }

  /** Names of the inputs whose content differs from what the stage last ran with. */
  private changedInputs(stage: StageDefinition): string[] {
    const before = this.stageState(stage.id).inputHashes ?? {};
    const now = this.inputHashes(stage);
    return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((name) => before[name] !== now[name]).sort();
  }

  stageState(stageId: string): StageState {
    const stageState = this.state.stages[stageId];
    if (!stageState) throw new Error(`Unknown stage "${stageId}".`);
    return stageState;
  }

  /** Called by the model gateway wrapper so model usage counts against the run's budget. */
  recordModelCall(): void {
    this.state.usage.modelCalls += 1;
  }

  private usageSnapshot(): RunState['usage'] {
    const running = this.activeSince !== undefined ? this.now().getTime() - this.activeSince : 0;
    return { ...this.state.usage, activeMs: this.state.usage.activeMs + running };
  }

  private stopClock(): void {
    if (this.activeSince !== undefined) {
      this.state.usage.activeMs += this.now().getTime() - this.activeSince;
      this.activeSince = undefined;
    }
  }

  private emit(type: string, actor: Actor, data: Record<string, unknown>, stageId?: string): void {
    const event = this.options.audit.append(type, actor, data, stageId);
    this.options.onEvent?.(event);
  }

  save(): void {
    this.state.updatedAt = this.now().toISOString();
    writeJsonAtomic(join(this.options.runDir, 'state.json'), this.state);
  }
}

/** A new, empty run state. */
export function newRunState(runId: string, workflowId: string, params: Record<string, unknown>, at: Date): RunState {
  const timestamp = at.toISOString();
  return {
    runId,
    workflowId,
    status: 'CREATED',
    createdAt: timestamp,
    updatedAt: timestamp,
    stages: {},
    artifacts: {},
    approvals: [],
    decisions: [],
    usage: { stageExecutions: 0, modelCalls: 0, activeMs: 0 },
    params,
  };
}
