import { architectureAgent, impactAnalysisAgent, planningAgent, requirementsAgent } from '../agents/analysis.ts';
import { documentationAgent, implementationAgent, testDesignAgent } from '../agents/delivery.ts';
import { designApprovalReasons, promoteAgent, releaseReadinessAgent, restoreTarget, type ReleaseRecord } from '../agents/release.ts';
import { ARTIFACT, type Design, type RequirementSpec } from '../agents/schemas.ts';
import type { AgentDeps } from '../agents/support.ts';
import { buildVerifyAgent, integrateAgent, policyReviewAgent } from '../agents/verification.ts';
import { memoryLedger, withFault, type FaultLedger, type FaultSpec } from '../engine/faults.ts';
import type { Agent, RetryPolicy, StageDefinition, WorkflowDefinition } from '../engine/types.ts';
import type { ModelGateway } from '../model/gateway.ts';
import type { CodeIndex } from '../tools/codeIndex.ts';
import {
  ambiguityLint,
  buildGreen,
  checklistComplete,
  criteriaCovered,
  designCoversRequirements,
  impactGrounded,
  laneGate,
  mergeClean,
  noBlockingFindings,
  openBlockingQuestions,
  planCoversRequirements,
  planStructure,
  promotionPreconditions,
  specConsistency,
  targetMatchesApproved,
  untrustedInputScreen,
  workspaceApplied,
} from './gates.ts';

export interface WorkflowOptions {
  /** How many times a failed build may send work back before the run stops. */
  maxReworks: number;
  faults: FaultSpec[];
  /** Where fired faults are counted. Defaults to memory; the runtime supplies one that survives a resume. */
  faultLedger?: FaultLedger | undefined;
  /** Used when the primary model gateway keeps failing. Absent when there is nothing to fall back to. */
  fallbackModel?: ModelGateway | undefined;
}

const MODEL_RETRY: RetryPolicy = { maxAttempts: 2, backoffMs: 500 };
const ONCE: RetryPolicy = { maxAttempts: 1, backoffMs: 0 };

/**
 * The software delivery lifecycle as a dependency graph.
 *
 *   requirements ─► impact-analysis ─► planning ─► architecture ─┬─► implementation ─┐
 *        ▲              (existing                    (approval)   ├─► test-design ────┼─► integrate ─┬─► build-verify ──┬─► release-readiness ─► promote
 *        │               code only)                               └─► documentation ──┘              └─► policy-review ─┘       (approval)
 *        └── clarifications, change requests                            ▲                                   │
 *                                                                       └──── build / review feedback ◄────┘
 *
 * The shape is fixed here, in code. Agents decide the content of each stage, and their output can
 * send work back or trigger re-planning, but no agent can add, remove or reorder a control.
 */
export function sdlcWorkflow(deps: AgentDeps, options: WorkflowOptions): WorkflowDefinition {
  const fault = (stageId: string): FaultSpec | undefined => options.faults.find((candidate) => candidate.stageId === stageId);
  const ledger = options.faultLedger ?? memoryLedger();
  const faulty = (agent: Agent, stageId: string): Agent => withFault(agent, fault(stageId), ledger);
  const fallbackDeps: AgentDeps | undefined = options.fallbackModel ? { ...deps, model: options.fallbackModel } : undefined;

  /** A stage whose agent calls the model: retried, and backed by the fallback gateway when there is one. */
  const modelStage = (
    stage: Omit<StageDefinition, 'agent' | 'fallback' | 'retry'>,
    factory: (agentDeps: AgentDeps) => Agent,
  ): StageDefinition => {
    const fallback = fallbackDeps ? factory(fallbackDeps) : undefined;
    return {
      ...stage,
      agent: faulty(factory(deps), stage.id),
      ...(fallback ? { fallback: { id: `${fallback.id}:fallback`, run: (context) => fallback.run(context) } } : {}),
      retry: MODEL_RETRY,
    };
  };

  const deliveryInputs = {
    dependsOn: ['architecture'],
    consumes: [ARTIFACT.spec, ARTIFACT.plan, ARTIFACT.design],
  };

  const stages: StageDefinition[] = [
    modelStage(
      {
        id: 'requirements',
        title: 'Requirement understanding',
        dependsOn: [],
        consumes: [ARTIFACT.requirement, ARTIFACT.baselineIndex],
        consumesOptional: [ARTIFACT.clarifications, ARTIFACT.changeRequests],
        produces: [ARTIFACT.spec],
        entryGates: [untrustedInputScreen],
        exitGates: [ambiguityLint, specConsistency],
        approval: {
          phase: 'after',
          required: ({ outputs }) => {
            const open = openBlockingQuestions(outputs![ARTIFACT.spec] as RequirementSpec);
            return open.length === 0
              ? null
              : { kind: 'clarification', reasons: open.map((question) => `${question.id} ("${question.term}"): ${question.question}`) };
          },
        },
      },
      requirementsAgent,
    ),

    modelStage(
      {
        id: 'impact-analysis',
        title: 'Codebase impact analysis',
        dependsOn: ['requirements'],
        consumes: [ARTIFACT.spec, ARTIFACT.baselineIndex],
        produces: [ARTIFACT.impact],
        exitGates: [impactGrounded],
        // Nothing to analyse when the system does not exist yet.
        enabled: (inputs) => (inputs[ARTIFACT.baselineIndex] as CodeIndex).files.length > 0,
      },
      impactAnalysisAgent,
    ),

    modelStage(
      {
        id: 'planning',
        title: 'Task decomposition',
        dependsOn: ['requirements', 'impact-analysis'],
        consumes: [ARTIFACT.spec],
        consumesOptional: [ARTIFACT.impact],
        produces: [ARTIFACT.plan],
        exitGates: [planStructure, planCoversRequirements],
      },
      planningAgent,
    ),

    modelStage(
      {
        id: 'architecture',
        title: 'Architecture and design',
        dependsOn: ['planning'],
        consumes: [ARTIFACT.spec, ARTIFACT.plan],
        consumesOptional: [ARTIFACT.impact],
        produces: [ARTIFACT.design],
        exitGates: [designCoversRequirements],
        // Risk-based: a design that changes nothing high-impact proceeds without a person.
        approval: {
          phase: 'after',
          required: ({ outputs }) => {
            const reasons = designApprovalReasons(outputs![ARTIFACT.design] as Design);
            return reasons.length === 0 ? null : { kind: 'approval', reasons: reasons.map((reason) => `The design ${reason}.`) };
          },
        },
      },
      architectureAgent,
    ),

    // The three delivery lanes run in parallel and only propose changes.
    modelStage(
      {
        id: 'implementation',
        title: 'Implementation',
        ...deliveryInputs,
        consumesOptional: [ARTIFACT.impact, ARTIFACT.buildFeedback, ARTIFACT.reviewFeedback],
        produces: [ARTIFACT.codeChanges],
        exitGates: [laneGate(deps, 'code', ARTIFACT.codeChanges)],
      },
      implementationAgent,
    ),
    modelStage(
      {
        id: 'test-design',
        title: 'Test design',
        ...deliveryInputs,
        consumesOptional: [ARTIFACT.impact, ARTIFACT.buildFeedback],
        produces: [ARTIFACT.testChanges],
        exitGates: [laneGate(deps, 'test', ARTIFACT.testChanges), criteriaCovered(deps)],
      },
      testDesignAgent,
    ),
    modelStage(
      {
        id: 'documentation',
        title: 'Documentation',
        ...deliveryInputs,
        consumesOptional: [ARTIFACT.impact],
        produces: [ARTIFACT.docChanges],
        exitGates: [laneGate(deps, 'docs', ARTIFACT.docChanges)],
      },
      documentationAgent,
    ),

    // Synchronization point: waits for all three lanes, then applies their proposals to the sandbox.
    {
      id: 'integrate',
      title: 'Integrate changes into the workspace',
      dependsOn: ['implementation', 'test-design', 'documentation'],
      consumes: [ARTIFACT.codeChanges, ARTIFACT.testChanges, ARTIFACT.docChanges, ARTIFACT.plan, ARTIFACT.design],
      produces: [ARTIFACT.workspace],
      agent: faulty(integrateAgent(deps), 'integrate'),
      entryGates: [mergeClean(deps)],
      exitGates: [workspaceApplied(deps)],
      retry: ONCE,
      compensate: async () => deps.workspace.reset(),
    },

    // Verification and policy review run in parallel on the integrated workspace.
    {
      id: 'build-verify',
      title: 'Build and test',
      dependsOn: ['integrate'],
      consumes: [ARTIFACT.workspace],
      produces: [ARTIFACT.testReport],
      agent: faulty(buildVerifyAgent(deps), 'build-verify'),
      exitGates: [buildGreen],
      retry: { maxAttempts: 2, backoffMs: 1000 },
      rework: { feedbackArtifact: ARTIFACT.buildFeedback, max: options.maxReworks },
      timeoutMs: 10 * 60 * 1000,
    },
    {
      id: 'policy-review',
      title: 'Security, compliance and change-control review',
      dependsOn: ['integrate'],
      consumes: [ARTIFACT.workspace, ARTIFACT.plan, ARTIFACT.design],
      produces: [ARTIFACT.policyReport],
      agent: faulty(policyReviewAgent(deps), 'policy-review'),
      exitGates: [noBlockingFindings],
      retry: ONCE,
      rework: { feedbackArtifact: ARTIFACT.reviewFeedback, max: 1 },
    },

    modelStage(
      {
        id: 'release-readiness',
        title: 'Release readiness',
        dependsOn: ['build-verify', 'policy-review'],
        consumes: [ARTIFACT.spec, ARTIFACT.design, ARTIFACT.testChanges, ARTIFACT.workspace, ARTIFACT.testReport, ARTIFACT.policyReport],
        produces: [ARTIFACT.releaseRecord],
        exitGates: [checklistComplete],
        // Never risk-based: a person signs off every release.
        approval: {
          phase: 'after',
          required: ({ outputs }) => {
            const record = outputs![ARTIFACT.releaseRecord] as ReleaseRecord;
            return {
              kind: 'approval',
              reasons: [
                `Release sign-off for ${record.changeId}: ${record.filesChanged.added} added, ${record.filesChanged.modified} modified, ${record.filesChanged.deleted} deleted; ${record.tests.succeeded}/${record.tests.total} tests pass.`,
                ...record.highImpactItems.map((item) => `High impact: ${item}`),
              ],
            };
          },
        },
      },
      releaseReadinessAgent,
    ),

    {
      id: 'promote',
      title: 'Promote to the target',
      dependsOn: ['release-readiness'],
      consumes: [ARTIFACT.releaseRecord, ARTIFACT.workspace],
      produces: [ARTIFACT.promotion],
      agent: faulty(promoteAgent(deps), 'promote'),
      entryGates: promotionPreconditions(deps),
      exitGates: [targetMatchesApproved(deps)],
      retry: ONCE,
      compensate: restoreTarget(deps),
    },
  ];

  const known = new Set(stages.map((stage) => stage.id));
  for (const spec of options.faults) {
    if (!known.has(spec.stageId)) throw new Error(`Fault names unknown stage "${spec.stageId}".`);
  }
  return { id: 'sdlc', stages };
}
