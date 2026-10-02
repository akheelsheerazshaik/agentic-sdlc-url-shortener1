import { z } from 'zod';

/**
 * The shape of every artifact the SDLC stages exchange.
 *
 * Model output is untrusted text until it has been parsed by one of these schemas. A response
 * that does not match is rejected and the stage is retried, so nothing malformed reaches a
 * downstream stage or the workspace.
 */

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[0-9]+(\\.[0-9]+)?$`), `must look like ${prefix}-1`);

// --- Requirements ----------------------------------------------------------------------------

export const acceptanceCriterionSchema = z.object({
  id: id('AC'),
  statement: z.string().min(1),
});

export const requirementSpecSchema = z.object({
  title: z.string().min(1),
  /** The problem restated as an engineering problem, in the agent's own words. */
  intent: z.string().min(1),
  functionalRequirements: z
    .array(
      z.object({
        id: id('FR'),
        statement: z.string().min(1),
        priority: z.enum(['must', 'should']),
        acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
      }),
    )
    .min(1),
  nonFunctionalRequirements: z.array(
    z.object({ id: id('NFR'), category: z.string().min(1), statement: z.string().min(1) }),
  ),
  ambiguities: z.array(
    z.object({
      id: id('Q'),
      /** The words in the requirement that are open to interpretation. */
      term: z.string().min(1),
      question: z.string().min(1),
      whyItMatters: z.string().min(1),
      options: z.array(z.string()).min(2),
      defaultAssumption: z.string().min(1),
      /** Blocking questions stop the run until a person answers them. */
      blocking: z.boolean(),
      resolution: z.string().optional(),
    }),
  ),
  assumptions: z.array(z.object({ id: id('A'), statement: z.string().min(1) })),
  outOfScope: z.array(z.string()),
});
export type RequirementSpec = z.infer<typeof requirementSpecSchema>;

// --- Impact analysis -------------------------------------------------------------------------

export const impactReportSchema = z.object({
  summary: z.string().min(1),
  impactedModules: z.array(
    z.object({ path: z.string().min(1), change: z.enum(['modify', 'extend']), reason: z.string().min(1) }),
  ),
  newModules: z.array(z.object({ path: z.string().min(1), purpose: z.string().min(1) })),
  apiImpact: z.array(z.object({ operation: z.string().min(1), change: z.string().min(1) })),
  dataImpact: z.array(z.string()),
  dataFlows: z.array(z.object({ flow: z.string().min(1), change: z.string().min(1) })),
  /** Added by static analysis, not by the model: every module that imports an impacted one. */
  regressionSurface: z.array(z.string()).default([]),
});
export type ImpactReport = z.infer<typeof impactReportSchema>;

// --- Plan ------------------------------------------------------------------------------------

export const laneSchema = z.enum(['code', 'test', 'docs']);
export type Lane = z.infer<typeof laneSchema>;

export const planSchema = z.object({
  approach: z.string().min(1),
  tasks: z
    .array(
      z.object({
        id: id('T'),
        title: z.string().min(1),
        lane: laneSchema,
        description: z.string().min(1),
        dependsOn: z.array(z.string()),
        requirementIds: z.array(z.string()).min(1),
        files: z.array(z.string()),
        risk: z.enum(['low', 'medium', 'high']),
      }),
    )
    .min(1),
});
export type Plan = z.infer<typeof planSchema>;

// --- Design ----------------------------------------------------------------------------------

/**
 * What the design says the change is allowed to touch. A person approves this, and the policy
 * review later blocks an implementation that goes beyond it.
 */
export const changeEnvelopeSchema = z.object({
  schemaChange: z.boolean(),
  apiChange: z.enum(['none', 'additive', 'breaking']),
  newDependencies: z.array(z.string()),
  touchesPersonalData: z.boolean(),
});
export type ChangeEnvelope = z.infer<typeof changeEnvelopeSchema>;

export const designSchema = z.object({
  overview: z.string().min(1),
  components: z.array(z.object({ name: z.string().min(1), responsibility: z.string().min(1), files: z.array(z.string()) })).min(1),
  apiChanges: z.array(z.object({ operation: z.string().min(1), change: z.string().min(1) })),
  dataModelChanges: z.array(z.string()),
  decisions: z
    .array(
      z.object({
        id: id('ADR'),
        title: z.string().min(1),
        decision: z.string().min(1),
        rationale: z.string().min(1),
        alternatives: z.array(z.string()),
      }),
    )
    .min(1),
  risks: z.array(
    z.object({
      id: id('R'),
      risk: z.string().min(1),
      likelihood: z.enum(['low', 'medium', 'high']),
      impact: z.enum(['low', 'medium', 'high']),
      mitigation: z.string().min(1),
    }),
  ),
  requirementCoverage: z.array(z.object({ requirementId: z.string().min(1), how: z.string().min(1) })),
  changeEnvelope: changeEnvelopeSchema,
});
export type Design = z.infer<typeof designSchema>;

// --- Change sets -----------------------------------------------------------------------------

export const fileChangeSchema = z
  .object({
    path: z.string().min(1),
    action: z.enum(['create', 'modify', 'delete']),
    content: z.string().optional(),
    /** The plan tasks this change delivers. Every change must trace to at least one. */
    taskIds: z.array(z.string()).min(1),
  })
  .refine((change) => change.action === 'delete' || change.content !== undefined, {
    message: 'content is required unless the file is deleted',
  });
export type FileChange = z.infer<typeof fileChangeSchema>;

export const changeSetSchema = z.object({
  summary: z.string().min(1),
  changes: z.array(fileChangeSchema).min(1),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

export const testChangeSetSchema = changeSetSchema.extend({
  /**
   * Which tests prove which acceptance criterion. `name` is the test's title, or a distinctive part
   * of it. The release gate looks each one up in the real test results and requires it to have passed.
   */
  coverage: z.array(
    z.object({
      criterionId: z.string().min(1),
      tests: z.array(z.object({ file: z.string().min(1), name: z.string().min(1) })).min(1),
    }),
  ),
});
export type TestChangeSet = z.infer<typeof testChangeSetSchema>;

// --- Release ---------------------------------------------------------------------------------

export const riskAssessmentSchema = z.object({
  summary: z.string().min(1),
  residualRisks: z.array(z.object({ risk: z.string().min(1), mitigation: z.string().min(1) })),
  rollbackPlan: z.array(z.string().min(1)).min(1),
  postReleaseChecks: z.array(z.string().min(1)),
});
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;

// --- Artifact names --------------------------------------------------------------------------

/** One place for the artifact names, so a typo is a compile error instead of a missing input at run time. */
export const ARTIFACT = {
  requirement: 'requirement',
  clarifications: 'clarifications',
  changeRequests: 'change-requests',
  baselineIndex: 'baseline-index',
  spec: 'requirement-spec',
  impact: 'impact-report',
  plan: 'plan',
  design: 'design',
  codeChanges: 'code-changes',
  testChanges: 'test-changes',
  docChanges: 'doc-changes',
  workspace: 'workspace-state',
  testReport: 'test-report',
  policyReport: 'policy-report',
  buildFeedback: 'build-feedback',
  reviewFeedback: 'review-feedback',
  releaseRecord: 'release-record',
  promotion: 'promotion-record',
} as const;
