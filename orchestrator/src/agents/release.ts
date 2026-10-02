import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StageFailure, type Agent } from '../engine/types.ts';
import { generateStructured } from '../model/gateway.ts';
import { listFiles, mirrorTree, snapshotTree } from '../util/fsx.ts';
import { hashOf } from '../util/hash.ts';
import {
  ARTIFACT,
  riskAssessmentSchema,
  type Design,
  type RequirementSpec,
  type RiskAssessment,
  type TestChangeSet,
} from './schemas.ts';
import { systemPrompt, tagged, type AgentDeps } from './support.ts';
import type { PolicyReport, TestReport, WorkspaceState } from './verification.ts';

export interface ChecklistItem {
  id: string;
  item: string;
  passed: boolean;
  evidence: string;
}

export interface ReleaseRecord {
  changeId: string;
  title: string;
  /** The exact tree this record is about. Promotion refuses any other. */
  treeHash: string;
  baselineHash: string;
  checklist: ChecklistItem[];
  /** High-impact aspects of the change that the release approver is signing off on explicitly. */
  highImpactItems: string[];
  filesChanged: { added: number; modified: number; deleted: number };
  tests: { total: number; succeeded: number };
  riskAssessment: RiskAssessment;
}

export interface PromotionRecord {
  targetDir: string;
  treeHash: string;
  filesInTarget: number;
}

/** Whether the design needed sign-off, per the same rule the architecture stage applies. */
export function designApprovalReasons(design: Design): string[] {
  const envelope = design.changeEnvelope;
  const reasons: string[] = [];
  if (envelope.schemaChange) reasons.push('changes the database schema');
  if (envelope.apiChange !== 'none') reasons.push(`changes the public API (${envelope.apiChange})`);
  if (envelope.newDependencies.length > 0) reasons.push(`adds or changes dependencies: ${envelope.newDependencies.join(', ')}`);
  if (envelope.touchesPersonalData) reasons.push('touches personal data');
  return reasons;
}

/**
 * Decides whether the change is ready for a person to release.
 *
 * The checklist is computed from evidence produced earlier in the run, never asserted by a model.
 * The model contributes only the written risk assessment and rollback plan that the approver reads.
 */
export function releaseReadinessAgent(deps: AgentDeps): Agent {
  return {
    id: 'agent:release-manager',
    async run(context) {
      const spec = context.inputs[ARTIFACT.spec] as RequirementSpec;
      const design = context.inputs[ARTIFACT.design] as Design;
      const workspace = context.inputs[ARTIFACT.workspace] as WorkspaceState;
      const tests = context.inputs[ARTIFACT.testReport] as TestReport;
      const policy = context.inputs[ARTIFACT.policyReport] as PolicyReport;
      const testChanges = context.inputs[ARTIFACT.testChanges] as TestChangeSet;

      // Every acceptance criterion must be proven by a named test that ran and passed in this build.
      const criteria = spec.functionalRequirements.flatMap((requirement) => requirement.acceptanceCriteria);
      const unproven: string[] = [];
      for (const criterion of criteria) {
        const cited = testChanges.coverage.find((entry) => entry.criterionId === criterion.id)?.tests ?? [];
        const proven = cited.some((test) =>
          tests.tests.cases.some((result) => result.file === test.file && result.name.includes(test.name) && result.status === 'passed'),
        );
        if (!proven) unproven.push(criterion.id);
      }

      const designReasons = designApprovalReasons(design);
      const designApproval = deps.facts
        .approvals()
        .find(
          (record) =>
            record.stageId === 'architecture' &&
            record.decision === 'approved' &&
            record.subjectHash === hashOf({ [ARTIFACT.design]: design }),
        );

      const checklist: ChecklistItem[] = [
        {
          id: 'REL-1',
          item: 'Build and policy review were run on exactly this change',
          passed: tests.treeHash === workspace.treeHash && policy.treeHash === workspace.treeHash,
          evidence: `workspace ${workspace.treeHash.slice(0, 12)}, tested ${tests.treeHash.slice(0, 12)}, reviewed ${policy.treeHash.slice(0, 12)}`,
        },
        {
          id: 'REL-2',
          item: 'Type-check passes',
          passed: tests.typecheck.passed,
          evidence: tests.typecheck.passed ? 'tsc --noEmit exited 0' : tests.typecheck.output.slice(-300),
        },
        {
          id: 'REL-3',
          item: 'All tests pass',
          passed: tests.tests.passed,
          evidence: `${tests.tests.succeeded}/${tests.tests.total} passed, ${tests.tests.failed} failed`,
        },
        {
          id: 'REL-4',
          item: 'Every acceptance criterion is proven by a test that passed',
          passed: unproven.length === 0,
          evidence: unproven.length === 0 ? `${criteria.length}/${criteria.length} criteria proven` : `not proven: ${unproven.join(', ')}`,
        },
        {
          id: 'REL-5',
          item: 'No blocking policy findings',
          passed: policy.counts.block === 0,
          evidence: `${policy.rules.length} rules evaluated: ${policy.counts.block} blocking, ${policy.counts.requireApproval} needing approval, ${policy.counts.warn} warnings`,
        },
        {
          id: 'REL-6',
          item: 'The design this change implements was approved by a person where required',
          passed: designReasons.length === 0 || designApproval !== undefined,
          evidence:
            designReasons.length === 0
              ? 'not required: the design declares no high-impact change'
              : designApproval
                ? `approved by ${designApproval.approver} (${designApproval.channel}) at ${designApproval.at}`
                : 'no approval on record for this design',
        },
      ];

      const riskAssessment = await generateStructured(
        deps.model,
        riskAssessmentSchema,
        {
          stageId: context.stageId,
          generation: context.generation,
          system: systemPrompt('release manager'),
          prompt: [
            'Write the risk assessment a release approver needs: a short summary, the residual risks with their mitigations, a concrete rollback plan as ordered steps, and the checks to make after release.',
            tagged('specification', spec),
            tagged('design', design),
            tagged('files_changed', workspace.files),
            tagged('policy_findings', policy.findings),
          ].join('\n\n'),
        },
        context.signal,
      );

      const record: ReleaseRecord = {
        changeId: `CHG-${context.runId}`,
        title: spec.title,
        treeHash: workspace.treeHash,
        baselineHash: workspace.baselineHash,
        checklist,
        highImpactItems: [...new Set(policy.findings.filter((finding) => finding.severity === 'REQUIRE_APPROVAL').map((finding) => `${finding.ruleId} ${finding.path ?? ''}: ${finding.message}`.replace('  ', ' ')))],
        filesChanged: {
          added: workspace.files.filter((file) => file.status === 'added').length,
          modified: workspace.files.filter((file) => file.status === 'modified').length,
          deleted: workspace.files.filter((file) => file.status === 'deleted').length,
        },
        tests: { total: tests.tests.total, succeeded: tests.tests.succeeded },
        riskAssessment,
      };
      return { outputs: { [ARTIFACT.releaseRecord]: record } };
    },
  };
}

const backupDir = (runDir: string): string => join(runDir, 'target-backup');
const backupMarker = (runDir: string): string => join(runDir, 'target-backup.complete');

/**
 * The one stage that changes anything outside the run: it copies the approved workspace over the
 * target. It backs the target up first and checks the result, and its compensation restores the
 * backup, so a failed or interrupted promotion leaves the target as it was.
 */
export function promoteAgent(deps: AgentDeps): Agent {
  return {
    id: 'agent:promoter',
    async run(context) {
      const release = context.inputs[ARTIFACT.releaseRecord] as ReleaseRecord;

      rmSync(backupMarker(deps.runDir), { force: true });
      mirrorTree(deps.targetDir, backupDir(deps.runDir));
      writeFileSync(backupMarker(deps.runDir), release.baselineHash);

      mirrorTree(deps.workspace.root, deps.targetDir);

      const promoted = snapshotTree(deps.targetDir);
      if (promoted.treeHash !== release.treeHash) {
        throw new StageFailure('the target does not match the approved change after copying', { retryable: false });
      }
      const record: PromotionRecord = {
        targetDir: deps.targetDir,
        treeHash: promoted.treeHash,
        filesInTarget: Object.keys(promoted.files).length,
      };
      return { outputs: { [ARTIFACT.promotion]: record } };
    },
  };
}

/** Puts the target back exactly as it was before promotion started. Does nothing if no backup was completed. */
export function restoreTarget(deps: Pick<AgentDeps, 'runDir' | 'targetDir'>): () => Promise<void> {
  return async () => {
    if (!existsSync(backupMarker(deps.runDir))) return;
    mirrorTree(backupDir(deps.runDir), deps.targetDir);
    if (listFiles(deps.targetDir).length !== listFiles(backupDir(deps.runDir)).length) {
      throw new Error('target does not match its backup after restore');
    }
  };
}
