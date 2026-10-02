import type { Agent, StageContext } from '../engine/types.ts';
import {
  ARTIFACT,
  changeSetSchema,
  testChangeSetSchema,
  type ImpactReport,
  type Lane,
  type Plan,
} from './schemas.ts';
import { CODE_CONVENTIONS, fileSections, modelAgent, tagged, type AgentDeps } from './support.ts';

/** Where each lane may write. A lane that writes elsewhere fails its exit gate. */
export const LANE_PATHS: Record<Lane, { directories: string[]; files: string[] }> = {
  code: {
    directories: ['src/', 'migrations/'],
    files: ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore'],
  },
  test: { directories: ['test/'], files: [] },
  docs: { directories: ['docs/'], files: ['README.md', 'openapi.yaml'] },
};

export function isLanePath(lane: Lane, path: string): boolean {
  const allowed = LANE_PATHS[lane];
  return allowed.files.includes(path) || allowed.directories.some((directory) => path.startsWith(directory));
}

function laneTasks(context: StageContext, lane: Lane): Plan['tasks'] {
  return (context.inputs[ARTIFACT.plan] as Plan).tasks.filter((task) => task.lane === lane);
}

/** The files a lane needs to read: what its tasks name, plus what the impact report says is affected. */
function relevantFiles(context: StageContext, lane: Lane): string[] {
  const impact = context.inputs[ARTIFACT.impact] as ImpactReport | undefined;
  return [
    ...laneTasks(context, lane).flatMap((task) => task.files),
    ...(impact?.impactedModules.map((module) => module.path) ?? []),
  ];
}

function sharedSections(context: StageContext, lane: Lane): string[] {
  const allowed = LANE_PATHS[lane];
  return [
    `You may write only under: ${[...allowed.directories, ...allowed.files].join(', ')}.`,
    'Return every file you create or modify in full, not as a diff. Cite the plan task ids each file delivers in `taskIds`.',
    tagged('specification', context.inputs[ARTIFACT.spec]),
    tagged('design', context.inputs[ARTIFACT.design]),
    tagged('your_tasks', laneTasks(context, lane)),
  ];
}

/** Feedback sent back by a later stage: failing tests, or a policy finding. */
function feedbackSections(context: StageContext): string[] {
  const sections: string[] = [];
  const build = context.inputs[ARTIFACT.buildFeedback];
  if (build) {
    sections.push('The build of the previous version failed. Fix the cause. Do not weaken or remove a test to make it pass.', tagged('build_feedback', build));
  }
  const review = context.inputs[ARTIFACT.reviewFeedback];
  if (review) {
    sections.push('The policy review blocked the previous version. Change the implementation so that every finding is resolved.', tagged('review_feedback', review));
  }
  return sections;
}

/** Writes the production code and migrations. It cannot touch tests, so it cannot edit a test into passing. */
export function implementationAgent(deps: AgentDeps): Agent {
  return modelAgent({
    id: 'agent:implementation',
    role: 'software engineer',
    schema: changeSetSchema,
    model: deps.model,
    prompt: (context) => [
      'Implement the code tasks of the plan, following the approved design exactly. Do not go beyond its change envelope.',
      ...sharedSections(context, 'code'),
      CODE_CONVENTIONS,
      fileSections(deps.workspace, relevantFiles(context, 'code')),
      ...feedbackSections(context),
    ],
    result: (changes) => ({ outputs: { [ARTIFACT.codeChanges]: changes } }),
  });
}

/**
 * Writes the tests from the specification and the design, not from the implementation.
 * Running in parallel with the implementation and without sight of it is what lets these tests
 * catch a requirement the implementation missed.
 */
export function testDesignAgent(deps: AgentDeps): Agent {
  return modelAgent({
    id: 'agent:test-design',
    role: 'test engineer',
    schema: testChangeSetSchema,
    model: deps.model,
    prompt: (context) => [
      'Write the tests for the test tasks of the plan. Derive them from the acceptance criteria and the design, not from any implementation.',
      'Cover every acceptance criterion, including the failure cases, and list in `coverage` which tests prove which criterion.',
      ...sharedSections(context, 'test'),
      CODE_CONVENTIONS,
      fileSections(deps.workspace, ['test/helpers.ts', ...relevantFiles(context, 'test')]),
      ...feedbackSections(context),
    ],
    result: (changes) => ({ outputs: { [ARTIFACT.testChanges]: changes } }),
  });
}

/** Updates the README and the API contract to match the change. */
export function documentationAgent(deps: AgentDeps): Agent {
  return modelAgent({
    id: 'agent:documentation',
    role: 'technical writer',
    schema: changeSetSchema,
    model: deps.model,
    prompt: (context) => [
      'Update the documentation for the docs tasks of the plan: the README and the OpenAPI contract. Describe what the design specifies, including new limitations.',
      ...sharedSections(context, 'docs'),
      fileSections(deps.workspace, ['README.md', 'openapi.yaml', ...relevantFiles(context, 'docs')]),
    ],
    result: (changes) => ({ outputs: { [ARTIFACT.docChanges]: changes } }),
  });
}
