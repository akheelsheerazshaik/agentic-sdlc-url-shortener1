import type { Agent } from '../engine/types.ts';
import { dependentsOf, type CodeIndex } from '../tools/codeIndex.ts';
import {
  ARTIFACT,
  designSchema,
  impactReportSchema,
  planSchema,
  requirementSpecSchema,
  type ImpactReport,
  type Plan,
  type RequirementSpec,
} from './schemas.ts';
import { fileSections, modelAgent, tagged, type AgentDeps, type RequirementInput } from './support.ts';

/** A compact description of the existing system for prompts: what is there, not the code itself. */
function describeBaseline(index: CodeIndex): string {
  if (index.files.length === 0) return 'There is no existing code. This is a new system.';
  return tagged('existing_system', {
    routes: index.routes.map((route) => `${route.method} ${route.path}`),
    tables: index.tables,
    migrations: index.migrations,
    modules: Object.fromEntries(
      Object.entries(index.modules)
        .filter(([path]) => path.startsWith('src/'))
        .map(([path, module]) => [path, { exports: module.exports, imports: module.imports }]),
    ),
    tests: index.tests,
  });
}

/** Stage 1. Turns free text into a specification and surfaces what the text leaves open. */
export function requirementsAgent(deps: AgentDeps): Agent {
  return modelAgent({
    id: 'agent:requirements',
    role: 'requirements analyst',
    schema: requirementSpecSchema,
    model: deps.model,
    prompt: (context) => {
      const requirement = context.inputs[ARTIFACT.requirement] as RequirementInput;
      const sections = [
        'Turn the requirement below into a specification an engineer can build and a tester can verify.',
        [
          'Find every term that can reasonably be read more than one way and record it as an ambiguity:',
          'quote the term exactly, give the options, and state the assumption you would make by default.',
          'Mark an ambiguity as blocking only when the readings lead to materially different work that is',
          'costly to undo, such as a different data model, personal data, or a different public API.',
          'Every functional requirement needs acceptance criteria that a test can check.',
        ].join(' '),
        tagged('requirement', requirement.text),
        describeBaseline(context.inputs[ARTIFACT.baselineIndex] as CodeIndex),
      ];
      const clarifications = context.inputs[ARTIFACT.clarifications];
      if (clarifications) {
        sections.push(
          'A person has answered questions. Apply the answers: set `resolution` on each answered ambiguity, set its `blocking` to false, and update the requirements to match.',
          tagged('clarifications', clarifications),
        );
      }
      const changeRequests = context.inputs[ARTIFACT.changeRequests];
      if (changeRequests) {
        sections.push('A reviewer has asked for changes. Revise the specification to include them.', tagged('change_requests', changeRequests));
      }
      return sections;
    },
    result: (spec: RequirementSpec) => ({
      outputs: { [ARTIFACT.spec]: spec },
      decisions: spec.ambiguities
        .filter((ambiguity) => !ambiguity.blocking)
        .map((ambiguity) => ({
          decision: `"${ambiguity.term}": ${ambiguity.resolution ?? ambiguity.defaultAssumption}`,
          rationale: ambiguity.resolution ? `Answered by a person. ${ambiguity.whyItMatters}` : `Default assumption. ${ambiguity.whyItMatters}`,
          alternatives: ambiguity.options,
        })),
    }),
  });
}

/** Stage 2 (existing codebases only). Says what the change touches; static analysis adds what depends on that. */
export function impactAnalysisAgent(deps: AgentDeps): Agent {
  return modelAgent({
    id: 'agent:impact-analysis',
    role: 'codebase analyst',
    schema: impactReportSchema,
    model: deps.model,
    prompt: (context) => [
      'Identify what in the existing codebase this specification affects: the modules to modify or extend, new modules needed, API operations, stored data, and data flows.',
      'List only paths that appear in the code index. Leave `regressionSurface` empty; it is computed from the import graph.',
      tagged('specification', context.inputs[ARTIFACT.spec]),
      tagged('code_index', context.inputs[ARTIFACT.baselineIndex]),
    ],
    result: (report: ImpactReport, context) => {
      const index = context.inputs[ARTIFACT.baselineIndex] as CodeIndex;
      const impacted = report.impactedModules.map((module) => module.path);
      return { outputs: { [ARTIFACT.impact]: { ...report, regressionSurface: dependentsOf(index, impacted) } } };
    },
  });
}

/** Stage 3. Breaks the specification into tasks with dependencies, assigned to the code, test and docs lanes. */
export function planningAgent(deps: AgentDeps): Agent {
  return modelAgent({
    id: 'agent:planning',
    role: 'delivery planner',
    schema: planSchema,
    model: deps.model,
    prompt: (context) => [
      'Break the specification into the smallest set of tasks that delivers it.',
      [
        'Each task belongs to one lane: "code" (src/, migrations/, build files), "test" (test/), or "docs" (README.md, docs/, openapi.yaml).',
        'Give each task the requirement ids it serves, the files it will create or change, the tasks it depends on, and a risk level.',
        'Every functional requirement must be served by at least one code task and one test task.',
      ].join(' '),
      tagged('specification', context.inputs[ARTIFACT.spec]),
      context.inputs[ARTIFACT.impact] ? tagged('impact_report', context.inputs[ARTIFACT.impact]) : 'There is no existing code to account for.',
    ],
    result: (plan: Plan) => ({
      outputs: { [ARTIFACT.plan]: plan },
      decisions: [{ decision: `Deliver in ${plan.tasks.length} tasks`, rationale: plan.approach }],
    }),
  });
}

/** Stage 4. Decides how to build it, and declares the envelope the implementation must stay inside. */
export function architectureAgent(deps: AgentDeps): Agent {
  return modelAgent({
    id: 'agent:architecture',
    role: 'software architect',
    schema: designSchema,
    model: deps.model,
    prompt: (context) => {
      const impact = context.inputs[ARTIFACT.impact] as ImpactReport | undefined;
      return [
        'Design the change: components and their responsibilities, API changes, data model changes, the decisions you made with the alternatives you rejected, and the risks with their mitigations.',
        [
          'State how each functional requirement is met in `requirementCoverage`.',
          'Fill in `changeEnvelope` truthfully: whether the schema changes, whether the API change is additive or breaking,',
          'every dependency added or re-versioned, and whether personal data is touched.',
          'A person approves this envelope, and the implementation is blocked if it goes beyond it.',
        ].join(' '),
        tagged('specification', context.inputs[ARTIFACT.spec]),
        tagged('plan', context.inputs[ARTIFACT.plan]),
        impact ? tagged('impact_report', impact) : 'There is no existing code.',
        impact ? fileSections(deps.workspace, impact.impactedModules.map((module) => module.path)) : '',
      ];
    },
    result: (design) => ({
      outputs: { [ARTIFACT.design]: design },
      decisions: design.decisions.map((decision) => ({
        decision: `${decision.id} ${decision.title}: ${decision.decision}`,
        rationale: decision.rationale,
        alternatives: decision.alternatives,
      })),
    }),
  });
}
