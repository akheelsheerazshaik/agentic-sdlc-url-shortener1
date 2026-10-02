import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { StageFailure, type Agent, type StageContext } from '../engine/types.ts';
import { blocking, describeFinding, type ChangeReview, type Finding } from '../governance/policy.ts';
import { CONTAINMENT_RULES } from '../governance/rules/index.ts';
import type { FileDiff } from '../tools/workspace.ts';
import { snapshotTree } from '../util/fsx.ts';
import { ARTIFACT, type ChangeSet, type Design, type FileChange, type Lane, type Plan } from './schemas.ts';
import type { AgentDeps } from './support.ts';

// --- Artifacts these stages produce ----------------------------------------------------------

export interface WorkspaceState {
  /** Hash of the target as it was when the run started. */
  baselineHash: string;
  /** Hash of the workspace after the change was applied: the identity of "this exact change". */
  treeHash: string;
  files: FileDiff[];
  /** Which plan tasks each changed file delivers. */
  taskIdsByPath: Record<string, string[]>;
}

export interface TestCaseResult {
  file: string;
  name: string;
  status: string;
}

export interface TestReport {
  /** The workspace this report is about. A report for a different tree proves nothing about this one. */
  treeHash: string;
  typecheck: { passed: boolean; output: string };
  tests: {
    passed: boolean;
    total: number;
    succeeded: number;
    failed: number;
    failures: { file: string; name: string; message: string }[];
    cases: TestCaseResult[];
  };
  durationMs: number;
}

export interface PolicyReport {
  treeHash: string;
  rules: { id: string; category: string; description: string }[];
  findings: Finding[];
  counts: { block: number; requireApproval: number; warn: number };
}

const LANE_ARTIFACTS: [Lane, string][] = [
  ['code', ARTIFACT.codeChanges],
  ['test', ARTIFACT.testChanges],
  ['docs', ARTIFACT.docChanges],
];

/** Combines the three lanes' change sets. Two lanes writing the same file is a conflict nobody resolved, so it fails. */
export function mergeChangeSets(inputs: Record<string, unknown>): FileChange[] {
  const merged: FileChange[] = [];
  const owner = new Map<string, Lane>();
  for (const [lane, artifact] of LANE_ARTIFACTS) {
    for (const change of (inputs[artifact] as ChangeSet).changes) {
      const existing = owner.get(change.path);
      if (existing) {
        throw new StageFailure(`the ${existing} and ${lane} lanes both change ${change.path}`, { retryable: false });
      }
      owner.set(change.path, lane);
      merged.push(change);
    }
  }
  return merged;
}

function reviewOf(deps: AgentDeps, changes: FileChange[], context: StageContext): ChangeReview {
  return {
    changes,
    baselineFiles: deps.workspace.baselineFiles(),
    readBaseline: deps.workspace.readBaseline,
    envelope: (context.inputs[ARTIFACT.design] as Design | undefined)?.changeEnvelope,
    plan: context.inputs[ARTIFACT.plan] as Plan | undefined,
  };
}

/**
 * Applies the proposed changes to the sandbox workspace.
 *
 * Agents only ever propose. This stage is the single point where proposals become files, and it
 * re-checks the containment rules on the merged change immediately before writing. It always
 * starts from the baseline, so running it twice gives the same tree.
 */
export function integrateAgent(deps: AgentDeps): Agent {
  return {
    id: 'agent:integrator',
    async run(context) {
      const changes = mergeChangeSets(context.inputs);
      const blocked = blocking(deps.policy.evaluate(reviewOf(deps, changes, context), CONTAINMENT_RULES));
      if (blocked.length > 0) {
        throw new StageFailure(`refusing to apply the change: ${blocked.map(describeFinding).join(' | ')}`, { retryable: false });
      }

      deps.workspace.reset();
      deps.workspace.apply(changes);

      const state: WorkspaceState = {
        baselineHash: snapshotTree(deps.workspace.baselineDir).treeHash,
        treeHash: deps.workspace.snapshot().treeHash,
        files: deps.workspace.diff().files,
        taskIdsByPath: Object.fromEntries(changes.map((change) => [change.path, change.taskIds])),
      };
      return { outputs: { [ARTIFACT.workspace]: state } };
    },
  };
}

interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { fullName: string; status: string; failureMessages: string[] }[];
  }[];
}

/** Path of a test file relative to the workspace, whichever way the runner spelled the absolute path. */
function relativeTestPath(workspaceRoot: string, absolute: string): string {
  for (const root of [workspaceRoot, realpathSync(workspaceRoot)]) {
    const candidate = relative(root, absolute);
    if (!candidate.startsWith('..')) return candidate.split(sep).join('/');
  }
  return absolute;
}

/**
 * Installs dependencies, type-checks and runs the test suite in the workspace, for real.
 *
 * A tool that cannot run (install fails, runner crashes) is an infrastructure failure and is
 * thrown, so the engine retries it. Tests that run and fail are a verdict on the change: they are
 * reported, and the exit gate sends the work back.
 */
export function buildVerifyAgent(deps: AgentDeps): Agent {
  return {
    id: 'agent:build-verifier',
    async run(context) {
      const started = Date.now();
      const state = context.inputs[ARTIFACT.workspace] as WorkspaceState;
      if (deps.workspace.snapshot().treeHash !== state.treeHash) {
        throw new StageFailure('the workspace no longer matches the integrated change', { retryable: false });
      }

      const install = await deps.commands.run('install', deps.workspace.root, context.signal);
      if (install.exitCode !== 0) {
        throw new StageFailure(`dependency install failed${install.timedOut ? ' (timed out)' : ''}: ${install.output.slice(-800)}`);
      }

      const typecheck = await deps.commands.run('typecheck', deps.workspace.root, context.signal);

      const resultsDir = join(deps.runDir, 'results');
      mkdirSync(resultsDir, { recursive: true });
      const resultsFile = join(resultsDir, `tests-generation-${context.generation}-attempt-${context.attempt}.json`);
      const testRun = await deps.commands.run('test', deps.workspace.root, context.signal, { resultsFile });
      if (!existsSync(resultsFile)) {
        throw new StageFailure(`the test runner produced no results${testRun.timedOut ? ' (timed out)' : ''}: ${testRun.output.slice(-800)}`);
      }
      const results = JSON.parse(readFileSync(resultsFile, 'utf8')) as VitestJson;

      const cases: TestCaseResult[] = [];
      const failures: TestReport['tests']['failures'] = [];
      for (const fileResult of results.testResults) {
        const file = relativeTestPath(deps.workspace.root, fileResult.name);
        if (fileResult.assertionResults.length === 0 && fileResult.status !== 'passed') {
          // The file could not be loaded at all, for example because it imports something that does not exist.
          failures.push({ file, name: '(file failed to load)', message: (fileResult.message ?? '').slice(0, 800) });
        }
        for (const assertion of fileResult.assertionResults) {
          cases.push({ file, name: assertion.fullName, status: assertion.status });
          if (assertion.status === 'failed') {
            failures.push({ file, name: assertion.fullName, message: (assertion.failureMessages[0] ?? '').slice(0, 800) });
          }
        }
      }

      const report: TestReport = {
        treeHash: state.treeHash,
        typecheck: { passed: typecheck.exitCode === 0, output: typecheck.exitCode === 0 ? '' : typecheck.output.slice(-2000) },
        tests: {
          passed: failures.length === 0 && results.numTotalTests > 0,
          total: results.numTotalTests,
          succeeded: results.numPassedTests,
          failed: failures.length,
          failures,
          cases,
        },
        durationMs: Date.now() - started,
      };
      return { outputs: { [ARTIFACT.testReport]: report } };
    },
  };
}

/**
 * Evaluates every policy rule against what is actually in the workspace, not against what the
 * agents said they changed.
 */
export function policyReviewAgent(deps: AgentDeps): Agent {
  return {
    id: 'agent:policy-reviewer',
    async run(context) {
      const state = context.inputs[ARTIFACT.workspace] as WorkspaceState;
      const changes: FileChange[] = state.files.map((file) => ({
        path: file.path,
        action: file.status === 'added' ? 'create' : file.status === 'deleted' ? 'delete' : 'modify',
        ...(file.status === 'deleted' ? {} : { content: readFileSync(join(deps.workspace.root, file.path), 'utf8') }),
        taskIds: state.taskIdsByPath[file.path] ?? [],
      }));

      const findings = deps.policy.evaluate(reviewOf(deps, changes, context));
      const report: PolicyReport = {
        treeHash: state.treeHash,
        rules: deps.policy.rules.map((rule) => ({ id: rule.id, category: rule.category, description: rule.description })),
        findings,
        counts: {
          block: findings.filter((finding) => finding.severity === 'BLOCK').length,
          requireApproval: findings.filter((finding) => finding.severity === 'REQUIRE_APPROVAL').length,
          warn: findings.filter((finding) => finding.severity === 'WARN').length,
        },
      };
      return { outputs: { [ARTIFACT.policyReport]: report } };
    },
  };
}
