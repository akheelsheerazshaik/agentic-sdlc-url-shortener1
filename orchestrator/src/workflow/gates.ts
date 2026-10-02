import { isLanePath } from '../agents/delivery.ts';
import type { ReleaseRecord } from '../agents/release.ts';
import {
  ARTIFACT,
  type ChangeSet,
  type Design,
  type ImpactReport,
  type Lane,
  type Plan,
  type RequirementSpec,
  type TestChangeSet,
} from '../agents/schemas.ts';
import type { AgentDeps, RequirementInput } from '../agents/support.ts';
import { mergeChangeSets, type PolicyReport, type TestReport, type WorkspaceState } from '../agents/verification.ts';
import type { Gate, GateOutcome } from '../engine/types.ts';
import { blocking, describeFinding } from '../governance/policy.ts';
import { CONTAINMENT_RULES } from '../governance/rules/index.ts';
import { screenUntrustedText } from '../governance/rules/security.ts';
import type { CodeIndex } from '../tools/codeIndex.ts';
import { snapshotTree } from '../util/fsx.ts';

/** Builds a gate outcome: passes when there are no problems. */
function outcome(problems: string[], okMessage: string): GateOutcome {
  return problems.length === 0 ? { passed: true, details: [okMessage] } : { passed: false, details: problems };
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

// --- Requirements ----------------------------------------------------------------------------

/** Entry gate: nothing a person typed reaches a model if it tries to instruct the agents. */
export const untrustedInputScreen: Gate = {
  id: 'SEC-004',
  description: 'Requirement text and human answers do not try to instruct the agents.',
  check: ({ inputs }) => {
    const requirement = inputs[ARTIFACT.requirement] as RequirementInput;
    const findings = [
      ...screenUntrustedText('the requirement', requirement.text),
      ...screenUntrustedText('a clarification', JSON.stringify(inputs[ARTIFACT.clarifications] ?? '')),
      ...screenUntrustedText('a change request', JSON.stringify(inputs[ARTIFACT.changeRequests] ?? '')),
    ];
    return outcome(findings.map(describeFinding), 'no instruction-like text found in human-supplied input');
  },
};

/** Words that sound like a requirement but do not say what to build. */
export const VAGUE_TERMS = [
  'better', 'safer', 'faster', 'easier', 'simpler', 'improve', 'improved', 'insight', 'insights',
  'user-friendly', 'robust', 'flexible', 'scalable', 'secure', 'modern', 'intuitive', 'seamless',
  'soon', 'as needed', 'and so on', 'etc', 'something', 'somehow', 'appropriate', 'reasonable',
];

export function vagueTermsIn(text: string): string[] {
  return VAGUE_TERMS.filter((term) => new RegExp(`(?<![A-Za-z-])${term.replace('-', '\\-')}(?![A-Za-z-])`, 'i').test(text));
}

/**
 * Exit gate: the agent may not paper over vagueness. Every vague word in the requirement must be
 * quoted in one of the ambiguities the specification records. The list of words is fixed and the
 * check is a string match, so the model cannot talk its way past it.
 */
export const ambiguityLint: Gate = {
  id: 'ambiguity-lint',
  description: 'Every vague term in the requirement is recorded as an ambiguity.',
  check: ({ inputs, outputs }) => {
    const requirement = inputs[ARTIFACT.requirement] as RequirementInput;
    const spec = outputs![ARTIFACT.spec] as RequirementSpec;
    const recorded = spec.ambiguities.map((ambiguity) => ambiguity.term.toLowerCase()).join(' | ');
    const missed = vagueTermsIn(requirement.text).filter((term) => !recorded.includes(term));
    return outcome(
      missed.map((term) => `the requirement says "${term}" but no ambiguity addresses it`),
      'every vague term in the requirement is addressed by a recorded ambiguity',
    );
  },
};

export const specConsistency: Gate = {
  id: 'spec-consistency',
  description: 'Requirement and criterion ids are unique, and human answers have been applied.',
  check: ({ inputs, outputs }) => {
    const spec = outputs![ARTIFACT.spec] as RequirementSpec;
    const ids = [
      ...spec.functionalRequirements.map((requirement) => requirement.id),
      ...spec.functionalRequirements.flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => criterion.id)),
      ...spec.nonFunctionalRequirements.map((requirement) => requirement.id),
      ...spec.ambiguities.map((ambiguity) => ambiguity.id),
    ];
    const problems = duplicates(ids).map((id) => `id ${id} is used more than once`);

    const answers = (inputs[ARTIFACT.clarifications] as { answers: Record<string, string> } | undefined)?.answers ?? {};
    for (const questionId of Object.keys(answers)) {
      const ambiguity = spec.ambiguities.find((candidate) => candidate.id === questionId);
      if (!ambiguity) problems.push(`an answer was given for ${questionId}, which is not in the specification`);
      else if (!ambiguity.resolution || ambiguity.blocking) problems.push(`${questionId} was answered by a person but is still open in the specification`);
    }
    return outcome(problems, `${ids.length} ids unique; ${Object.keys(answers).length} human answer(s) applied`);
  },
};

/** Blocking questions without an answer stop the run until a person provides one. */
export function openBlockingQuestions(spec: RequirementSpec): RequirementSpec['ambiguities'] {
  return spec.ambiguities.filter((ambiguity) => ambiguity.blocking && !ambiguity.resolution);
}

// --- Impact analysis -------------------------------------------------------------------------

/** Exit gate: the agent's claims about the codebase are checked against the codebase. */
export const impactGrounded: Gate = {
  id: 'impact-grounded',
  description: 'Every module the impact report names exists; every new module does not exist yet.',
  check: ({ inputs, outputs }) => {
    const index = inputs[ARTIFACT.baselineIndex] as CodeIndex;
    const report = outputs![ARTIFACT.impact] as ImpactReport;
    const problems = [
      ...report.impactedModules.filter((module) => !index.files.includes(module.path)).map((module) => `${module.path} does not exist in the codebase`),
      ...report.newModules.filter((module) => index.files.includes(module.path)).map((module) => `${module.path} is listed as new but already exists`),
    ];
    return outcome(problems, `${report.impactedModules.length} impacted and ${report.newModules.length} new modules checked against the code index`);
  },
};

// --- Plan ------------------------------------------------------------------------------------

export const planStructure: Gate = {
  id: 'plan-structure',
  description: 'Tasks form a dependency graph without cycles, and all three lanes have work.',
  check: ({ outputs }) => {
    const plan = outputs![ARTIFACT.plan] as Plan;
    const ids = plan.tasks.map((task) => task.id);
    const problems = duplicates(ids).map((id) => `task id ${id} is used more than once`);
    for (const task of plan.tasks) {
      for (const dependency of task.dependsOn) {
        if (!ids.includes(dependency)) problems.push(`${task.id} depends on ${dependency}, which is not in the plan`);
      }
    }
    // Cycle check: repeatedly remove tasks whose dependencies are all removed.
    const remaining = new Map(plan.tasks.map((task) => [task.id, task.dependsOn.filter((dependency) => ids.includes(dependency))]));
    for (let progressed = true; progressed; ) {
      progressed = false;
      for (const [id, dependencies] of remaining) {
        if (dependencies.every((dependency) => !remaining.has(dependency))) {
          remaining.delete(id);
          progressed = true;
        }
      }
    }
    if (remaining.size > 0) problems.push(`tasks depend on each other in a cycle: ${[...remaining.keys()].join(', ')}`);
    for (const lane of ['code', 'test', 'docs'] as const) {
      if (!plan.tasks.some((task) => task.lane === lane)) problems.push(`the plan has no ${lane} task`);
    }
    return outcome(problems, `${plan.tasks.length} tasks, acyclic, all lanes covered`);
  },
};

export const planCoversRequirements: Gate = {
  id: 'plan-covers-requirements',
  description: 'Every functional requirement has a code task and a test task; no task cites an unknown requirement.',
  check: ({ inputs, outputs }) => {
    const spec = inputs[ARTIFACT.spec] as RequirementSpec;
    const plan = outputs![ARTIFACT.plan] as Plan;
    const known = new Set([
      ...spec.functionalRequirements.map((requirement) => requirement.id),
      ...spec.nonFunctionalRequirements.map((requirement) => requirement.id),
    ]);
    const problems: string[] = [];
    for (const task of plan.tasks) {
      for (const requirementId of task.requirementIds) {
        if (!known.has(requirementId)) problems.push(`${task.id} cites ${requirementId}, which is not in the specification`);
      }
    }
    for (const requirement of spec.functionalRequirements) {
      for (const lane of ['code', 'test'] as const) {
        if (!plan.tasks.some((task) => task.lane === lane && task.requirementIds.includes(requirement.id))) {
          problems.push(`${requirement.id} has no ${lane} task`);
        }
      }
    }
    return outcome(problems, `${spec.functionalRequirements.length} functional requirements each have code and test tasks`);
  },
};

// --- Design ----------------------------------------------------------------------------------

export const designCoversRequirements: Gate = {
  id: 'design-covers-requirements',
  description: 'The design says how every functional requirement is met, and its change envelope matches its content.',
  check: ({ inputs, outputs }) => {
    const spec = inputs[ARTIFACT.spec] as RequirementSpec;
    const design = outputs![ARTIFACT.design] as Design;
    const covered = new Set(design.requirementCoverage.map((entry) => entry.requirementId));
    const problems = spec.functionalRequirements
      .filter((requirement) => !covered.has(requirement.id))
      .map((requirement) => `the design does not say how ${requirement.id} is met`);
    if (design.dataModelChanges.length > 0 && !design.changeEnvelope.schemaChange) {
      problems.push('the design lists data model changes but its envelope declares no schema change');
    }
    if (design.apiChanges.length > 0 && design.changeEnvelope.apiChange === 'none') {
      problems.push('the design lists API changes but its envelope declares none');
    }
    return outcome(problems, `${spec.functionalRequirements.length} functional requirements covered; envelope is consistent with the design`);
  },
};

// --- Change sets -----------------------------------------------------------------------------

/**
 * Exit gate for each delivery lane, run on that lane's own output before anyone else sees it:
 * the lane stayed in its own directories, cited real tasks from its own lane, and wrote nothing
 * the containment rules forbid.
 */
export function laneGate(deps: AgentDeps, lane: Lane, artifact: string): Gate {
  return {
    id: `${lane}-lane`,
    description: `The ${lane} lane writes only its own files, cites its own tasks, and passes the containment rules.`,
    check: ({ inputs, outputs }) => {
      const changeSet = outputs![artifact] as ChangeSet;
      const plan = inputs[ARTIFACT.plan] as Plan;
      const laneTaskIds = new Set(plan.tasks.filter((task) => task.lane === lane).map((task) => task.id));
      const problems: string[] = [];

      for (const path of duplicates(changeSet.changes.map((change) => change.path))) problems.push(`${path} appears more than once`);
      for (const change of changeSet.changes) {
        if (!isLanePath(lane, change.path)) problems.push(`${change.path} is outside what the ${lane} lane may write`);
        for (const taskId of change.taskIds) {
          if (!laneTaskIds.has(taskId)) problems.push(`${change.path} cites ${taskId}, which is not a ${lane} task in the plan`);
        }
      }
      const findings = deps.policy.evaluate(
        { changes: changeSet.changes, baselineFiles: deps.workspace.baselineFiles(), readBaseline: deps.workspace.readBaseline },
        CONTAINMENT_RULES,
      );
      problems.push(...blocking(findings).map(describeFinding));
      return outcome(problems, `${changeSet.changes.length} file(s), all within the ${lane} lane and the containment rules`);
    },
  };
}

export function criteriaCovered(deps: AgentDeps): Gate {
  return {
    id: 'criteria-covered',
    description: 'Every acceptance criterion names at least one test, in a test file that exists.',
    check: ({ inputs, outputs }) => {
      const spec = inputs[ARTIFACT.spec] as RequirementSpec;
      const tests = outputs![ARTIFACT.testChanges] as TestChangeSet;
      const available = new Set([...deps.workspace.baselineFiles(), ...tests.changes.filter((change) => change.action !== 'delete').map((change) => change.path)]);
      const problems: string[] = [];
      const criteria = spec.functionalRequirements.flatMap((requirement) => requirement.acceptanceCriteria);
      for (const criterion of criteria) {
        const entry = tests.coverage.find((candidate) => candidate.criterionId === criterion.id);
        if (!entry) {
          problems.push(`${criterion.id} has no test`);
          continue;
        }
        for (const test of entry.tests) {
          if (!available.has(test.file)) problems.push(`${criterion.id} cites ${test.file}, which does not exist`);
        }
      }
      return outcome(problems, `${criteria.length} acceptance criteria each cite a test`);
    },
  };
}

// --- Integration -----------------------------------------------------------------------------

/**
 * Entry gate for the stage that writes to the workspace: the three lanes' proposals must combine
 * into one change with no file claimed twice, and the combined change must pass the containment
 * rules. Each lane was already checked on its own; this checks them together.
 */
export function mergeClean(deps: AgentDeps): Gate {
  return {
    id: 'merge-clean',
    description: 'The lanes do not conflict, and the merged change passes the containment rules.',
    check: ({ inputs }) => {
      let merged;
      try {
        merged = mergeChangeSets(inputs);
      } catch (error) {
        return { passed: false, details: [(error as Error).message] };
      }
      const findings = deps.policy.evaluate(
        { changes: merged, baselineFiles: deps.workspace.baselineFiles(), readBaseline: deps.workspace.readBaseline },
        CONTAINMENT_RULES,
      );
      return outcome(blocking(findings).map(describeFinding), `${merged.length} file change(s) from three lanes merge without conflict`);
    },
  };
}

/** Exit gate: the workspace on disk is what the stage says it produced, and every changed file is traced to a task. */
export function workspaceApplied(deps: AgentDeps): Gate {
  return {
    id: 'workspace-applied',
    description: 'The workspace on disk matches the recorded tree hash, and every changed file cites a task.',
    check: ({ outputs }) => {
      const state = outputs![ARTIFACT.workspace] as WorkspaceState;
      const problems: string[] = [];
      if (deps.workspace.snapshot().treeHash !== state.treeHash) problems.push('the workspace on disk does not match the recorded tree hash');
      for (const file of state.files) {
        if ((state.taskIdsByPath[file.path] ?? []).length === 0) problems.push(`${file.path} changed but cites no task`);
      }
      return outcome(problems, `${state.files.length} file(s) applied; tree ${state.treeHash.slice(0, 12)}`);
    },
  };
}

// --- Verification ----------------------------------------------------------------------------

export const buildGreen: Gate = {
  id: 'build-green',
  description: 'The change type-checks and every test passes.',
  check: ({ outputs }) => {
    const report = outputs![ARTIFACT.testReport] as TestReport;
    const problems: string[] = [];
    if (!report.typecheck.passed) problems.push(`type-check failed: ${report.typecheck.output.slice(-600)}`);
    if (report.tests.total === 0) problems.push('no tests ran');
    for (const failure of report.tests.failures.slice(0, 10)) {
      problems.push(`test failed: ${failure.file} > ${failure.name}: ${failure.message.split('\n')[0]}`);
    }
    return outcome(problems, `type-check passed; ${report.tests.succeeded}/${report.tests.total} tests passed`);
  },
};

export const noBlockingFindings: Gate = {
  id: 'policy-clean',
  description: 'No policy rule blocks the change.',
  check: ({ outputs }) => {
    const report = outputs![ARTIFACT.policyReport] as PolicyReport;
    return outcome(
      blocking(report.findings).map(describeFinding),
      `${report.rules.length} rules evaluated, none blocking (${report.counts.requireApproval} need approval, ${report.counts.warn} warnings)`,
    );
  },
};

export const checklistComplete: Gate = {
  id: 'release-checklist',
  description: 'Every item on the release checklist passes.',
  check: ({ outputs }) => {
    const record = outputs![ARTIFACT.releaseRecord] as ReleaseRecord;
    return outcome(
      record.checklist.filter((item) => !item.passed).map((item) => `${item.id} ${item.item}: ${item.evidence}`),
      `${record.checklist.length}/${record.checklist.length} checklist items pass`,
    );
  },
};

// --- Promotion -------------------------------------------------------------------------------

/**
 * Entry gates for the only stage that writes outside the run.
 * They close two gaps between "approved" and "applied": the target changing under the run, and
 * the workspace changing after it was approved.
 */
export function promotionPreconditions(deps: AgentDeps): Gate[] {
  return [
    {
      id: 'no-target-drift',
      description: 'The target is still exactly what this change was built and tested against.',
      check: ({ inputs }) => {
        const workspace = inputs[ARTIFACT.workspace] as WorkspaceState;
        const current = snapshotTree(deps.targetDir).treeHash;
        return outcome(
          current === workspace.baselineHash ? [] : ['the target changed after this run started; the change was verified against an older version'],
          'target is unchanged since the run started',
        );
      },
    },
    {
      id: 'approved-is-applied',
      description: 'The workspace is byte-for-byte the tree the release approver signed off.',
      check: ({ inputs }) => {
        const release = inputs[ARTIFACT.releaseRecord] as ReleaseRecord;
        const current = deps.workspace.snapshot().treeHash;
        return outcome(
          current === release.treeHash ? [] : ['the workspace differs from the approved release record'],
          `workspace matches the approved tree ${release.treeHash.slice(0, 12)}`,
        );
      },
    },
  ];
}

/** Exit gate: reads the target back from disk and compares it with what was approved, independently of the stage's own report. */
export function targetMatchesApproved(deps: AgentDeps): Gate {
  return {
    id: 'target-matches-approved',
    description: 'After promotion, the target is byte-for-byte the approved tree.',
    check: ({ inputs }) => {
      const release = inputs[ARTIFACT.releaseRecord] as ReleaseRecord;
      const actual = snapshotTree(deps.targetDir).treeHash;
      return outcome(
        actual === release.treeHash ? [] : [`the target is ${actual.slice(0, 12)}, the approved tree is ${release.treeHash.slice(0, 12)}`],
        `target matches the approved tree ${release.treeHash.slice(0, 12)}`,
      );
    },
  };
}
