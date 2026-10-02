#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { ApprovalProvider, HumanDecision } from './engine/engine.ts';
import { parseFault } from './engine/faults.ts';
import { AuditLog, type AuditEvent } from './governance/audit.ts';
import { collectMetrics } from './governance/metrics.ts';
import { writeReviewPacket } from './report/reviewPacket.ts';
import { createRun, DEFAULT_LIMITS, loadScenario, openRun, type Mode, type RunHandle, type RunParams } from './runtime.ts';
import { displayPath as display } from './util/fsx.ts';

const USAGE = `
Agentic SDLC orchestrator

  run       --scenario <dir> --target <dir> [options]     Start a run from a scenario
  run       --requirement "<text>" --target <dir> --mode live [options]
  resume    <run> [--retry --by <name>]                   Continue a paused run, or retry a stopped one
  status    <run>                                         Stages, pending decisions, usage
  approve   <run> <stage> --by <name> [--comment <text>]  Approve what a stage is waiting on
  reject    <run> <stage> --by <name> --comment <text>    Reject it: the run rolls back and stops
  request-changes <run> <stage> --by <name> --comment <text>   Send it back with a change request
  clarify   <run> --by <name> --answer Q-1="..." [...]    Answer the open questions
  stop      <run>                                         Ask a live run to stop safely
  lineage   <run> <artifact>                              What an artifact was derived from
  graph     <run>                                         The workflow graph with its gates and controls
  audit     <run>                                         Verify the audit log's hash chain
  metrics                                                 Reliability metrics across all runs

Options
  --runs <dir>          Where runs are stored (default ./runs)
  --run-id <id>         Name for the new run (default <scenario>-<timestamp>)
  --mode offline|live   offline replays the scenario's recorded model replies (default);
                        live calls the model named by SDLC_MODEL using ANTHROPIC_API_KEY
  --approvals pause|interactive    pause (default) exits when a person is needed;
                        interactive asks in this terminal
  --max-reworks <n>     Times a failed build may send work back (default 2)
  --fault <spec>        Inject a failure: <stage>=error:<n|always> or <stage>=error-after:<n|always>
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string' },
    requirement: { type: 'string' },
    target: { type: 'string' },
    runs: { type: 'string', default: 'runs' },
    'run-id': { type: 'string' },
    mode: { type: 'string', default: 'offline' },
    approvals: { type: 'string', default: 'pause' },
    'max-reworks': { type: 'string', default: '2' },
    fault: { type: 'string', multiple: true, default: [] },
    by: { type: 'string' },
    comment: { type: 'string' },
    answer: { type: 'string', multiple: true, default: [] },
    retry: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

/** Keeps one event on roughly one line. The full text is always in the audit log. */
function clip(text: string, limit = 260): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function need(value: string | undefined, what: string): string {
  if (value === undefined || value === '') fail(`${what} is required`);
  return value;
}

/** One line per event that changes what a person watching should know. */
function printEvent(event: AuditEvent): void {
  const stage = event.stageId ? `${event.stageId}: ` : '';
  const data = event.data;
  const line = ((): string | undefined => {
    switch (event.type) {
      case 'STAGE_STARTED':
        return `▶ ${stage}started (generation ${data.generation}, attempt ${data.attempt}${data.fallback ? ', fallback agent' : ''})`;
      case 'STAGE_SUCCEEDED':
        return `✔ ${stage}succeeded`;
      case 'STAGE_SKIPPED':
        return `– ${stage}skipped (${data.reason})`;
      case 'GATE_EVALUATED':
        return data.passed ? undefined : `✘ ${stage}${data.kind} gate "${event.actor.id}" failed: ${(data.details as string[]).join(' | ')}`;
      case 'STAGE_ATTEMPT_FAILED':
        // A failed exit gate was already printed in full on the line above.
        return `✘ ${stage}attempt ${data.attempt} failed${data.willRetry ? ', retrying' : ''}${String(data.error).startsWith('exit gate failed') ? '' : `: ${data.error}`}`;
      case 'FALLBACK_ACTIVATED':
        return `↪ ${stage}switching to fallback agent ${data.to}`;
      case 'REWORK_REQUESTED':
        return `↺ ${stage}sent work back upstream (loop ${data.iteration} of ${data.max})`;
      case 'STAGE_INVALIDATED':
        return `↺ ${stage}invalidated, will re-run: ${data.reason}${Array.isArray(data.changedInputs) ? ` (${data.changedInputs.join(', ')})` : ''}`;
      case 'STAGE_REUSED':
        return `= ${stage}reused, inputs unchanged`;
      case 'APPROVAL_REQUESTED':
        return `⏸ ${stage}waiting for ${data.kind === 'clarification' ? 'answers' : 'approval'}: ${(data.reasons as string[]).join(' | ')}`;
      case 'APPROVAL_RECORDED':
        return `✎ ${stage}${data.decision} by ${data.approver}`;
      case 'ROLLBACK_STARTED':
        return `⏪ rolling back: ${(data.stages as string[]).join(', ')}`;
      case 'STAGE_FAILED':
        return `✘ ${stage}FAILED`;
      default:
        return undefined;
    }
  })();
  if (line) console.log(`  ${clip(line)}`);
}

/**
 * Asks for decisions in this terminal while the run is live.
 * One prompt at a time: if two stages need a person at once, the second waits for the first.
 */
function interactiveProvider(handleRef: { handle?: RunHandle }): ApprovalProvider {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const lines = terminal[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question);
    const answer = await lines.next();
    return answer.done ? '' : answer.value.trim();
  };
  let queue: Promise<unknown> = Promise.resolve();

  return (request) => {
    const turn = queue.then(async () => {
      const handle = handleRef.handle!;
      const packet = writeReviewPacket({ runDir: handle.runDir, state: handle.state, graph: handle.engine.graph, artifacts: handle.engine.artifacts, workspace: handle.workspace });
      console.log(`\n${request.title} (${request.stageId}) needs ${request.kind === 'clarification' ? 'answers' : 'approval'}:`);
      for (const reason of request.reasons) console.log(`  - ${reason}`);
      console.log(`Review packet: ${display(packet)}`);

      const approver = await ask('Your name: ');
      // No name means nobody is there to decide (for example, input was closed): leave the stage waiting.
      if (approver === '') return null;

      if (request.kind === 'clarification') {
        const answers: Record<string, string> = {};
        for (const reason of request.reasons) {
          const id = /^(Q-\d+)/.exec(reason)?.[1];
          if (id) answers[id] = await ask(`${id} answer: `);
        }
        return { decision: { decision: 'clarified', approver, answers } satisfies HumanDecision, channel: 'interactive' as const };
      }

      const choice = (await ask('approve / changes / reject / later: ')).toLowerCase();
      if (choice.startsWith('a')) return { decision: { decision: 'approved', approver } satisfies HumanDecision, channel: 'interactive' as const };
      if (choice.startsWith('c') || choice.startsWith('r')) {
        const comment = await ask('Reason: ');
        const decision: HumanDecision = choice.startsWith('c')
          ? { decision: 'changes_requested', approver, comment }
          : { decision: 'rejected', approver, comment };
        return { decision, channel: 'interactive' as const };
      }
      return null;
    });
    queue = turn.catch(() => undefined);
    return turn;
  };
}

function printStatus(handle: RunHandle): void {
  const { state, engine } = handle;
  console.log(`\nRun ${state.runId}: ${state.status}${state.stopReason ? `. ${clip(state.stopReason, 400)}` : ''}`);
  for (const stage of engine.graph.stages) {
    const stageState = state.stages[stage.id]!;
    const extra = [
      stageState.generation > 1 ? `generation ${stageState.generation}` : '',
      stageState.usedFallback ? 'fallback' : '',
      stageState.reworksTriggered > 0 ? `${stageState.reworksTriggered} rework` : '',
    ].filter(Boolean);
    console.log(`  ${stageState.status.padEnd(18)} ${stage.id}${extra.length > 0 ? `  (${extra.join(', ')})` : ''}`);
  }
  for (const stage of engine.graph.stages) {
    const pending = state.stages[stage.id]!.pendingApproval;
    if (!pending) continue;
    console.log(`\n  ${stage.id} is waiting for ${pending.kind === 'clarification' ? 'answers' : 'approval'}:`);
    for (const reason of pending.reasons) console.log(`    - ${reason}`);
  }
  console.log(`\n  Review packet: ${display(join(handle.runDir, 'review', 'README.md'))}`);
}

/** Runs the engine until it finishes, pauses or stops, then writes the review packet. */
async function execute(handle: RunHandle): Promise<number> {
  await handle.engine.run();
  writeReviewPacket({ runDir: handle.runDir, state: handle.state, graph: handle.engine.graph, artifacts: handle.engine.artifacts, workspace: handle.workspace });
  printStatus(handle);
  // Exit codes let scripts tell the outcomes apart: 0 done, 3 waiting for a person, 4 stopped safely.
  return handle.state.status === 'SUCCEEDED' ? 0 : handle.state.status === 'PAUSED' ? 3 : 4;
}

function wiring(handleRef: { handle?: RunHandle }) {
  return {
    onEvent: printEvent,
    approvalProvider: flags.approvals === 'interactive' ? interactiveProvider(handleRef) : undefined,
  };
}

async function main(): Promise<number> {
  const [command, ...rest] = positionals;
  if (flags.help || !command) {
    console.log(USAGE);
    return 0;
  }
  const runsDir = resolve(flags.runs);
  const handleRef: { handle?: RunHandle } = {};

  switch (command) {
    case 'run': {
      if (flags.mode !== 'offline' && flags.mode !== 'live') fail('--mode must be offline or live');
      if (flags.approvals !== 'pause' && flags.approvals !== 'interactive') fail('--approvals must be pause or interactive');
      const targetDir = resolve(need(flags.target, '--target'));
      flags.fault.forEach(parseFault);

      const scenarioDir = flags.scenario ? resolve(flags.scenario) : undefined;
      const scenario = scenarioDir ? loadScenario(scenarioDir) : undefined;
      const requirement = scenario?.requirement ?? {
        title: 'Ad-hoc requirement',
        text: need(flags.requirement, '--scenario or --requirement'),
        source: 'command-line',
      };
      const params: RunParams = {
        scenarioId: scenario?.id ?? 'adhoc',
        scenarioDir,
        targetDir,
        mode: flags.mode as Mode,
        maxReworks: Number(flags['max-reworks']),
        faults: flags.fault,
        limits: DEFAULT_LIMITS,
      };
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const runId = flags['run-id'] ?? `${params.scenarioId}-${stamp}`;
      console.log(`Run ${runId}: "${requirement.title}" (${params.mode} mode) → ${display(targetDir)}`);
      handleRef.handle = createRun(runsDir, runId, params, requirement, wiring(handleRef));
      return execute(handleRef.handle);
    }

    case 'resume': {
      const runId = need(rest[0], 'run id');
      handleRef.handle = openRun(runsDir, runId, wiring(handleRef));
      if (flags.retry) {
        // Authorization first: the stop request is only cleared once a person has been accepted as the one retrying.
        handleRef.handle.engine.prepareRetry(need(flags.by, '--by'));
        rmSync(join(handleRef.handle.runDir, 'STOP'), { force: true });
      } else if (handleRef.handle.state.status === 'SAFE_STOPPED') {
        fail('this run was stopped. Fix the cause, then authorize a retry with: resume <run> --retry --by <name>');
      }
      return execute(handleRef.handle);
    }

    case 'approve':
    case 'reject':
    case 'request-changes': {
      const handle = openRun(runsDir, need(rest[0], 'run id'));
      const stageId = need(rest[1], 'stage');
      const approver = need(flags.by, '--by');
      const decision: HumanDecision =
        command === 'approve'
          ? { decision: 'approved', approver, ...(flags.comment ? { comment: flags.comment } : {}) }
          : { decision: command === 'reject' ? 'rejected' : 'changes_requested', approver, comment: need(flags.comment, '--comment') };
      handle.engine.submitDecision(stageId, decision, 'cli');
      console.log(`Recorded: ${stageId} ${decision.decision} by ${approver}. Continue with: resume ${handle.runId}`);
      return 0;
    }

    case 'clarify': {
      const handle = openRun(runsDir, need(rest[0], 'run id'));
      const approver = need(flags.by, '--by');
      const answers: Record<string, string> = {};
      for (const answer of flags.answer) {
        const separator = answer.indexOf('=');
        if (separator < 1) fail(`--answer must look like Q-1="your answer", got "${answer}"`);
        answers[answer.slice(0, separator)] = answer.slice(separator + 1);
      }
      if (Object.keys(answers).length === 0) fail('at least one --answer is required');
      const stage = handle.engine.graph.stages.find((candidate) => handle.state.stages[candidate.id]?.pendingApproval?.kind === 'clarification');
      if (!stage) fail('no stage in this run is waiting for clarification');
      handle.engine.submitDecision(stage.id, { decision: 'clarified', approver, answers }, 'cli');
      console.log(`Recorded ${Object.keys(answers).length} answer(s) from ${approver}. Continue with: resume ${handle.runId}`);
      return 0;
    }

    case 'stop': {
      const runDir = resolve(runsDir, need(rest[0], 'run id'));
      if (!existsSync(runDir)) fail(`no run "${rest[0]}"`);
      writeFileSync(join(runDir, 'STOP'), `${new Date().toISOString()}\n`);
      console.log('Stop requested. A live run stops safely before starting its next stage.');
      return 0;
    }

    case 'status': {
      const handle = openRun(runsDir, need(rest[0], 'run id'));
      printStatus(handle);
      return 0;
    }

    case 'graph': {
      // The workflow exactly as the engine holds it, so the documentation of the graph cannot drift from the code.
      const handle = openRun(runsDir, need(rest[0], 'run id'));
      const row = (cells: string[]): string => `| ${cells.join(' | ')} |`;
      console.log(row(['Stage', 'Depends on', 'Entry gates', 'Exit gates', 'Human checkpoint', 'On failure', 'Undo']));
      console.log(row(Array(7).fill('---')));
      for (const stage of handle.engine.graph.stages) {
        const recovery = [
          `${stage.retry?.maxAttempts ?? 2} attempt(s)`,
          stage.fallback ? 'then fallback agent' : '',
          stage.rework ? `exit gate failure sends work back (max ${stage.rework.max})` : '',
        ].filter(Boolean);
        console.log(
          row([
            `\`${stage.id}\`${stage.enabled ? ' (conditional)' : ''}`,
            stage.dependsOn.join(', ') || '-',
            (stage.entryGates ?? []).map((gate) => gate.id).join(', ') || 'required inputs present',
            (stage.exitGates ?? []).map((gate) => gate.id).join(', ') || '-',
            stage.approval ? `${stage.approval.phase} the stage` : '-',
            recovery.join('; '),
            stage.compensate ? 'yes' : '-',
          ]),
        );
      }
      return 0;
    }

    case 'lineage': {
      const handle = openRun(runsDir, need(rest[0], 'run id'));
      const lines = handle.engine.artifacts.lineage(need(rest[1], 'artifact name'));
      console.log(lines.length > 0 ? lines.join('\n') : `No artifact named "${rest[1]}". Known: ${Object.keys(handle.state.artifacts).join(', ')}`);
      return 0;
    }

    case 'audit': {
      const file = join(runsDir, need(rest[0], 'run id'), 'audit.jsonl');
      const result = AuditLog.verify(file);
      console.log(result.valid ? `OK: ${result.events} events, hash chain intact.` : `BROKEN at event ${result.brokenAt}: ${result.reason}`);
      return result.valid ? 0 : 1;
    }

    case 'metrics': {
      const metrics = collectMetrics(runsDir);
      const percent = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
      const duration = (value: number | null | undefined): string => (value === null || value === undefined ? 'n/a' : `${(value / 1000).toFixed(1)} s`);
      console.log(`Runs: ${metrics.runs} (${metrics.finishedRuns} finished)`);
      console.log(`Success rate:            ${percent(metrics.successRate)}`);
      console.log(`Retry rate:              ${percent(metrics.retryRate)} of stage executions`);
      console.log(`Rework loops per run:    ${metrics.reworkLoopsPerRun?.toFixed(2) ?? 'n/a'}`);
      console.log(`Rollback frequency:      ${percent(metrics.rollbackFrequency)} of finished runs`);
      console.log(`MTTR:                    ${duration(metrics.mttrMs)} over ${metrics.recoveries} recoveries (${metrics.unresolvedFailures} unresolved)`);
      console.log(`End-to-end latency:      p50 ${duration(metrics.latencyMs?.p50)}, p95 ${duration(metrics.latencyMs?.p95)}, mean ${duration(metrics.latencyMs?.mean)} (active time, succeeded runs)`);
      console.log(`Waiting on people, mean: ${duration(metrics.meanWaitingOnHumansMs)}`);
      console.log('');
      for (const run of metrics.perRun) {
        console.log(`  ${run.runId.padEnd(34)} ${run.outcome.padEnd(13)} executions ${String(run.stageExecutions).padStart(2)}  retries ${run.retries}  fallbacks ${run.fallbacks}  rework ${run.reworkLoops}  invalidated ${run.replannedStages}  rollbacks ${run.rollbacks}  active ${duration(run.activeMs)}`);
      }
      if (existsSync(runsDir)) writeFileSync(join(runsDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
      return 0;
    }

    default:
      fail(`unknown command "${command}". Run with --help.`);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
