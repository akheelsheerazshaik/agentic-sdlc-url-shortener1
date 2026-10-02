import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReleaseRecord } from '../agents/release.ts';
import {
  ARTIFACT,
  type Design,
  type ImpactReport,
  type Plan,
  type RequirementSpec,
  type TestChangeSet,
} from '../agents/schemas.ts';
import type { PolicyReport, TestReport, WorkspaceState } from '../agents/verification.ts';
import type { ArtifactStore } from '../engine/artifacts.ts';
import type { WorkflowGraph } from '../engine/graph.ts';
import type { RunState } from '../engine/types.ts';
import { AuditLog } from '../governance/audit.ts';
import { runMetrics } from '../governance/metrics.ts';
import type { Workspace } from '../tools/workspace.ts';
import { displayPath } from '../util/fsx.ts';
import { short } from '../util/hash.ts';

interface PacketInput {
  runDir: string;
  state: RunState;
  graph: WorkflowGraph;
  artifacts: ArtifactStore;
  workspace: Workspace;
}

const table = (header: string[], rows: string[][]): string =>
  [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;


/** Latest accepted version of an artifact, or the proposed one a person is being asked to approve. */
function current<T>(artifacts: ArtifactStore, name: string): { value: T; note: string } | undefined {
  const accepted = artifacts.latest(name);
  const proposed = artifacts.latest(name, 'proposed');
  const version = proposed && (!accepted || proposed.version > accepted.version) ? proposed : accepted;
  if (!version) return undefined;
  const note = `v${version.version}, ${version.status === 'proposed' ? '**awaiting approval**' : version.status}, hash \`${short(version.hash)}\`, produced by ${version.producedBy.actor}`;
  return { value: artifacts.read<T>(version), note };
}

function overview({ runDir, state, graph }: PacketInput): string {
  const events = AuditLog.read(join(runDir, 'audit.jsonl'));
  const verification = AuditLog.verify(join(runDir, 'audit.jsonl'));
  const metrics = runMetrics(events);
  const lines: string[] = [`# Run ${state.runId}`, ''];

  lines.push(`**Status: ${state.status}**${state.stopReason ? `. ${state.stopReason}` : ''}`, '');
  lines.push(
    table(
      ['', ''],
      [
        ['Scenario', String(state.params.scenarioId)],
        ['Mode', state.params.mode === 'live' ? 'live model' : 'offline (recorded model replies; gates, policies, build and approvals run for real)'],
        ['Target', `\`${displayPath(String(state.params.targetDir))}\``],
        ['Stage executions', `${state.usage.stageExecutions} (${metrics.retries} retried, ${metrics.fallbacks} fallback, ${metrics.reworkLoops} rework loop(s), ${metrics.replannedStages} stage(s) invalidated and re-run)`],
        ['Model calls', String(state.usage.modelCalls)],
        ['Active time', `${seconds(state.usage.activeMs)} (plus ${seconds(metrics.waitingOnHumansMs)} waiting for people)`],
        ['Audit log', `${verification.events} events, hash chain ${verification.valid ? 'verified' : `BROKEN at event ${verification.brokenAt}: ${verification.reason}`}`],
      ],
    ),
    '',
  );

  const waiting = graph.stages.filter((stage) => state.stages[stage.id]?.pendingApproval);
  if (waiting.length > 0) {
    lines.push('## Waiting for a person', '');
    for (const stage of waiting) {
      const pending = state.stages[stage.id]!.pendingApproval!;
      lines.push(`### ${stage.title} (\`${stage.id}\`) needs ${pending.kind === 'clarification' ? 'answers' : 'approval'}`, '');
      lines.push(...pending.reasons.map((reason) => `- ${reason}`), '');
      lines.push(
        '```bash',
        ...(pending.kind === 'clarification'
          ? [`node src/cli.ts clarify ${state.runId} --by <your-name> --answer Q-1="..."`]
          : [
              `node src/cli.ts approve ${state.runId} ${stage.id} --by <your-name>`,
              `node src/cli.ts request-changes ${state.runId} ${stage.id} --by <your-name> --comment "..."`,
              `node src/cli.ts reject ${state.runId} ${stage.id} --by <your-name> --comment "..."`,
            ]),
        `node src/cli.ts resume ${state.runId}`,
        '```',
        '',
      );
    }
  }

  lines.push('## Stages', '');
  lines.push(
    table(
      ['Stage', 'Status', 'Generation', 'Attempts', 'Notes'],
      graph.stages.map((stage) => {
        const stageState = state.stages[stage.id]!;
        const notes = [
          stageState.usedFallback ? 'used fallback agent' : '',
          stageState.reworksTriggered > 0 ? `sent work back ${stageState.reworksTriggered}x` : '',
          stageState.lastError ? `error: ${stageState.lastError.slice(0, 160)}` : '',
        ].filter(Boolean);
        return [stage.title, stageState.status, String(stageState.generation), String(stageState.attempts), notes.join('; ')];
      }),
    ),
    '',
  );

  lines.push('## Human decisions', '');
  lines.push(
    state.approvals.length === 0
      ? 'None yet.'
      : table(
          ['When', 'Stage', 'Decision', 'By', 'Channel', 'Covers', 'Comment'],
          state.approvals.map((record) => [record.at, record.stageId, record.decision, record.approver, record.channel, `\`${short(record.subjectHash)}\``, record.comment]),
        ),
    '',
  );
  if (state.approvals.some((record) => record.channel === 'scripted')) {
    lines.push('> Decisions on the `scripted` channel were supplied by a demo or test script standing in for a person.', '');
  }

  lines.push('## Files in this packet', '');
  lines.push(
    '- `specification.md`: what was understood, what was ambiguous, what was assumed',
    '- `plan-and-design.md`: impact on the codebase, tasks, design decisions, risks',
    '- `changes.md` and `changes.diff`: what changed, traced from requirement to test',
    '- `verification.md`: test results, policy findings, release checklist, risk assessment',
    '- `lineage.md`: decisions, artifact lineage and the event timeline',
    '',
  );
  return lines.join('\n');
}

function specification({ artifacts }: PacketInput): string {
  const spec = current<RequirementSpec>(artifacts, ARTIFACT.spec);
  const requirement = artifacts.content<{ text: string }>(ARTIFACT.requirement);
  const lines = ['# Specification', ''];
  lines.push('## Requirement as received', '', ...(requirement?.text ?? '').split('\n').map((line) => `> ${line}`), '');
  if (!spec) return [...lines, 'Not produced yet.'].join('\n');
  const { value } = spec;
  lines.push(`_${spec.note}_`, '', `## ${value.title}`, '', value.intent, '');

  lines.push('## Functional requirements', '');
  for (const requirement of value.functionalRequirements) {
    lines.push(`**${requirement.id}** (${requirement.priority}) ${requirement.statement}`, '');
    lines.push(...requirement.acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.statement}`), '');
  }
  if (value.nonFunctionalRequirements.length > 0) {
    lines.push('## Non-functional requirements', '');
    lines.push(...value.nonFunctionalRequirements.map((requirement) => `- **${requirement.id}** (${requirement.category}) ${requirement.statement}`), '');
  }
  lines.push('## Ambiguities', '');
  if (value.ambiguities.length === 0) lines.push('None identified.', '');
  for (const ambiguity of value.ambiguities) {
    const status = ambiguity.resolution ? 'answered by a person' : ambiguity.blocking ? '**blocking, needs an answer**' : 'proceeding on the default assumption';
    lines.push(`### ${ambiguity.id}: "${ambiguity.term}" (${status})`, '');
    lines.push(ambiguity.question, '', `Why it matters: ${ambiguity.whyItMatters}`, '');
    lines.push(...ambiguity.options.map((option) => `- ${option}`), '');
    lines.push(ambiguity.resolution ? `Answer: ${ambiguity.resolution}` : `Default assumption: ${ambiguity.defaultAssumption}`, '');
  }
  if (value.assumptions.length > 0) lines.push('## Assumptions', '', ...value.assumptions.map((assumption) => `- **${assumption.id}** ${assumption.statement}`), '');
  if (value.outOfScope.length > 0) lines.push('## Out of scope', '', ...value.outOfScope.map((item) => `- ${item}`), '');

  const changeRequests = artifacts.content<{ requests: { by: string; request: string; raisedAt: string }[] }>(ARTIFACT.changeRequests);
  if (changeRequests) {
    lines.push('## Change requests applied', '', ...changeRequests.requests.map((request) => `- ${request.by}, at ${request.raisedAt}: ${request.request}`), '');
  }
  return lines.join('\n');
}

function planAndDesign({ artifacts }: PacketInput): string {
  const lines = ['# Plan and design', ''];

  const impact = current<ImpactReport>(artifacts, ARTIFACT.impact);
  lines.push('## Impact on the existing codebase', '');
  if (!impact) {
    lines.push('Not applicable: there was no existing code, or the analysis has not run yet.', '');
  } else {
    lines.push(`_${impact.note}_`, '', impact.value.summary, '');
    lines.push(table(['Module', 'Change', 'Reason'], impact.value.impactedModules.map((module) => [`\`${module.path}\``, module.change, module.reason])), '');
    if (impact.value.newModules.length > 0) lines.push(table(['New module', 'Purpose'], impact.value.newModules.map((module) => [`\`${module.path}\``, module.purpose])), '');
    if (impact.value.apiImpact.length > 0) lines.push('API:', ...impact.value.apiImpact.map((api) => `- \`${api.operation}\`: ${api.change}`), '');
    if (impact.value.dataImpact.length > 0) lines.push('Data:', ...impact.value.dataImpact.map((item) => `- ${item}`), '');
    if (impact.value.dataFlows.length > 0) lines.push('Data flows:', ...impact.value.dataFlows.map((flow) => `- ${flow.flow}: ${flow.change}`), '');
    lines.push(
      `Regression surface, from the import graph (${impact.value.regressionSurface.length} modules depend on what changes):`,
      ...impact.value.regressionSurface.map((path) => `- \`${path}\``),
      '',
    );
  }

  const plan = current<Plan>(artifacts, ARTIFACT.plan);
  lines.push('## Task plan', '');
  if (!plan) {
    lines.push('Not produced yet.', '');
  } else {
    lines.push(`_${plan.note}_`, '', plan.value.approach, '');
    lines.push(
      table(
        ['Task', 'Lane', 'Title', 'Depends on', 'Requirements', 'Risk', 'Files'],
        plan.value.tasks.map((task) => [task.id, task.lane, task.title, task.dependsOn.join(', ') || '-', task.requirementIds.join(', '), task.risk, task.files.map((file) => `\`${file}\``).join(' ')]),
      ),
      '',
    );
  }

  const design = current<Design>(artifacts, ARTIFACT.design);
  lines.push('## Design', '');
  if (!design) return [...lines, 'Not produced yet.'].join('\n');
  const { value } = design;
  lines.push(`_${design.note}_`, '', value.overview, '');
  lines.push(table(['Component', 'Responsibility', 'Files'], value.components.map((component) => [component.name, component.responsibility, component.files.map((file) => `\`${file}\``).join(' ')])), '');
  if (value.apiChanges.length > 0) lines.push('### API changes', '', ...value.apiChanges.map((api) => `- \`${api.operation}\`: ${api.change}`), '');
  if (value.dataModelChanges.length > 0) lines.push('### Data model changes', '', ...value.dataModelChanges.map((change) => `- ${change}`), '');
  lines.push('### Change envelope (what the approver signed off)', '');
  lines.push(
    table(
      ['Aspect', 'Declared'],
      [
        ['Schema change', value.changeEnvelope.schemaChange ? 'yes' : 'no'],
        ['API change', value.changeEnvelope.apiChange],
        ['Dependencies added or changed', value.changeEnvelope.newDependencies.join(', ') || 'none'],
        ['Touches personal data', value.changeEnvelope.touchesPersonalData ? 'yes' : 'no'],
      ],
    ),
    '',
  );
  lines.push('### Decisions', '');
  for (const decision of value.decisions) {
    lines.push(`**${decision.id} ${decision.title}.** ${decision.decision}`, '', `Why: ${decision.rationale}`, '');
    if (decision.alternatives.length > 0) lines.push('Rejected:', ...decision.alternatives.map((alternative) => `- ${alternative}`), '');
  }
  lines.push('### Risks', '');
  lines.push(table(['Id', 'Risk', 'Likelihood', 'Impact', 'Mitigation'], value.risks.map((risk) => [risk.id, risk.risk, risk.likelihood, risk.impact, risk.mitigation])), '');
  lines.push('### How each requirement is met', '', ...value.requirementCoverage.map((entry) => `- **${entry.requirementId}**: ${entry.how}`), '');
  return lines.join('\n');
}

function changes({ artifacts }: PacketInput): string {
  const lines = ['# Changes', ''];
  const state = current<WorkspaceState>(artifacts, ARTIFACT.workspace);
  if (!state) return [...lines, 'Nothing has been integrated yet.'].join('\n');
  lines.push(`_${state.note}_`, '', `Baseline \`${short(state.value.baselineHash)}\` → workspace \`${short(state.value.treeHash)}\`. Full diff: \`changes.diff\`.`, '');
  lines.push(
    table(
      ['File', 'Status', '+', '-', 'Tasks'],
      state.value.files.map((file) => [`\`${file.path}\``, file.status, String(file.additions), String(file.deletions), (state.value.taskIdsByPath[file.path] ?? []).join(', ')]),
    ),
    '',
  );

  const spec = current<RequirementSpec>(artifacts, ARTIFACT.spec)?.value;
  const plan = current<Plan>(artifacts, ARTIFACT.plan)?.value;
  const tests = current<TestChangeSet>(artifacts, ARTIFACT.testChanges)?.value;
  const report = current<TestReport>(artifacts, ARTIFACT.testReport)?.value;
  if (spec && plan && tests) {
    lines.push('## Traceability: requirement → criterion → tasks → tests', '');
    const rows: string[][] = [];
    for (const requirement of spec.functionalRequirements) {
      const tasks = plan.tasks.filter((task) => task.requirementIds.includes(requirement.id)).map((task) => task.id);
      for (const criterion of requirement.acceptanceCriteria) {
        const cited = tests.coverage.find((entry) => entry.criterionId === criterion.id)?.tests ?? [];
        const verdict = (test: { file: string; name: string }): string => {
          if (!report) return 'not run yet';
          return report.tests.cases.some((result) => result.file === test.file && result.name.includes(test.name) && result.status === 'passed') ? 'passed' : 'NOT PASSED';
        };
        rows.push([requirement.id, `${criterion.id} ${criterion.statement}`, tasks.join(', '), cited.map((test) => `${test.name} (${verdict(test)})`).join('; ') || 'NONE']);
      }
    }
    lines.push(table(['Requirement', 'Acceptance criterion', 'Tasks', 'Proving tests'], rows), '');
  }
  return lines.join('\n');
}

function verification({ artifacts }: PacketInput): string {
  const lines = ['# Verification', ''];

  const tests = current<TestReport>(artifacts, ARTIFACT.testReport);
  lines.push('## Build and tests', '');
  if (!tests) {
    lines.push('Not run yet.', '');
  } else {
    lines.push(`_${tests.note}_`, '');
    lines.push(`- Type-check: ${tests.value.typecheck.passed ? 'passed' : 'FAILED'}`);
    lines.push(`- Tests: ${tests.value.tests.succeeded}/${tests.value.tests.total} passed, ${tests.value.tests.failed} failed, in ${seconds(tests.value.durationMs)}`, '');
    for (const failure of tests.value.tests.failures) lines.push(`- FAILED \`${failure.file}\` › ${failure.name}`, `  ${failure.message.split('\n')[0]}`);
  }
  const feedback = artifacts.content<{ iteration: number; failures: string[] }>(ARTIFACT.buildFeedback);
  if (feedback) {
    lines.push('', `### Earlier build that was sent back (rework loop ${feedback.iteration})`, '', ...feedback.failures.map((failure) => `- ${failure}`), '');
  }

  const policy = current<PolicyReport>(artifacts, ARTIFACT.policyReport);
  lines.push('', '## Policy review', '');
  if (!policy) {
    lines.push('Not run yet.', '');
  } else {
    lines.push(`_${policy.note}_`, '');
    lines.push(table(['Rule', 'Category', 'What it enforces', 'Result'], policy.value.rules.map((rule) => {
      const findings = policy.value.findings.filter((finding) => finding.ruleId === rule.id);
      const worst = findings.some((finding) => finding.severity === 'BLOCK') ? 'BLOCKED' : findings.some((finding) => finding.severity === 'REQUIRE_APPROVAL') ? 'needs approval' : findings.length > 0 ? 'warning' : 'pass';
      return [rule.id, rule.category, rule.description, worst];
    })), '');
    if (policy.value.findings.length > 0) {
      lines.push('Findings:', ...policy.value.findings.map((finding) => `- **${finding.ruleId} ${finding.severity}**${finding.path ? ` \`${finding.path}\`` : ''}: ${finding.message}`), '');
    }
  }

  const release = current<ReleaseRecord>(artifacts, ARTIFACT.releaseRecord);
  lines.push('## Release readiness', '');
  if (!release) return [...lines, 'Not assessed yet.'].join('\n');
  const { value } = release;
  lines.push(`_${release.note}_`, '', `Change \`${value.changeId}\`: ${value.title}. Tree \`${short(value.treeHash)}\`.`, '');
  lines.push(table(['Check', 'Item', 'Result', 'Evidence'], value.checklist.map((item) => [item.id, item.item, item.passed ? 'pass' : 'FAIL', item.evidence])), '');
  if (value.highImpactItems.length > 0) lines.push('High-impact items the release approver signs off explicitly:', ...value.highImpactItems.map((item) => `- ${item}`), '');
  lines.push('### Risk assessment', '', value.riskAssessment.summary, '');
  lines.push(table(['Residual risk', 'Mitigation'], value.riskAssessment.residualRisks.map((risk) => [risk.risk, risk.mitigation])), '');
  lines.push('Rollback plan:', ...value.riskAssessment.rollbackPlan.map((step, index) => `${index + 1}. ${step}`), '');
  lines.push('After release, check:', ...value.riskAssessment.postReleaseChecks.map((check) => `- ${check}`), '');
  return lines.join('\n');
}

function lineage({ runDir, state, artifacts }: PacketInput): string {
  const lines = ['# Decisions, lineage and timeline', ''];

  lines.push('## Decisions made by agents', '');
  lines.push(
    state.decisions.length === 0
      ? 'None recorded.'
      : table(
          ['Stage', 'Gen', 'Decision', 'Rationale', 'Alternatives considered'],
          state.decisions.map((decision) => [decision.stageId, String(decision.generation), decision.decision, decision.rationale, (decision.alternatives ?? []).join('; ') || '-']),
        ),
    '',
  );

  lines.push('## Artifact versions', '');
  lines.push(
    table(
      ['Artifact', 'Version', 'Status', 'Hash', 'Produced by', 'Stage (generation)'],
      Object.values(state.artifacts).flat().map((version) => [version.name, `v${version.version}`, version.status, `\`${short(version.hash)}\``, version.producedBy.actor, `${version.producedBy.stageId} (${version.producedBy.generation})`]),
    ),
    '',
  );

  const outcome = [ARTIFACT.promotion, ARTIFACT.releaseRecord, ARTIFACT.workspace, ARTIFACT.design, ARTIFACT.spec].find((name) => artifacts.lineage(name).length > 0);
  if (outcome) {
    lines.push(`## Lineage of \`${outcome}\``, '', 'Each line was derived from the lines indented beneath it. A line ending in … is expanded where it first appears.', '', '```', ...artifacts.lineage(outcome), '```', '');
  }

  const notable = new Set([
    'RUN_CREATED', 'RUN_STARTED', 'RUN_RESUMED', 'RUN_PAUSED', 'RUN_SUCCEEDED', 'RUN_SAFE_STOPPED', 'STAGE_SKIPPED', 'STAGE_SUCCEEDED',
    'STAGE_ATTEMPT_FAILED', 'STAGE_FAILED', 'FALLBACK_ACTIVATED', 'REWORK_REQUESTED', 'STAGE_INVALIDATED', 'STAGE_REUSED', 'APPROVAL_REQUESTED',
    'APPROVAL_RECORDED', 'APPROVAL_VOIDED', 'HUMAN_INPUT_RECORDED', 'ROLLBACK_STARTED', 'COMPENSATION_EXECUTED', 'COMPENSATION_FAILED',
    'BUDGET_EXCEEDED', 'STOP_REQUESTED', 'RETRY_AUTHORIZED', 'STAGE_RECOVERED', 'ARTIFACT_UNCHANGED',
  ]);
  const describe = (data: Record<string, unknown>): string => {
    const text = (['reason', 'error', 'decision', 'to', 'failures', 'changedInputs', 'waitingOn', 'reasons', 'stages', 'scenario', 'mode', 'kind', 'artifact', 'name'] as const)
      .filter((key) => data[key] !== undefined)
      .map((key) => `${key}: ${Array.isArray(data[key]) ? (data[key] as unknown[]).join('; ') : String(data[key])}`)
      .join(' · ');
    return text.length > 220 ? `${text.slice(0, 217)}...` : text;
  };
  lines.push('## Timeline', '', 'Selected events from `audit.jsonl`.', '');
  lines.push(
    table(
      ['#', 'Time', 'Event', 'Stage', 'Actor', 'Detail'],
      AuditLog.read(join(runDir, 'audit.jsonl'))
        .filter((event) => notable.has(event.type))
        .map((event) => [String(event.seq), event.ts.slice(11, 23), event.type, event.stageId ?? '', event.actor.kind === 'agent' ? event.actor.id : `${event.actor.kind}:${event.actor.id}`, describe(event.data)]),
    ),
    '',
  );
  return lines.join('\n');
}

/**
 * Writes the review packet: the run's outcome in a form a person can read and decide on.
 * It is regenerated every time the run pauses or ends, so an approver always reviews the current state.
 */
export function writeReviewPacket(input: PacketInput): string {
  const directory = join(input.runDir, 'review');
  mkdirSync(directory, { recursive: true });
  const write = (name: string, content: string): void => writeFileSync(join(directory, name), `${content.trimEnd()}\n`);

  write('README.md', overview(input));
  write('specification.md', specification(input));
  write('plan-and-design.md', planAndDesign(input));
  write('changes.md', changes(input));
  write('verification.md', verification(input));
  write('lineage.md', lineage(input));
  if (input.artifacts.latest(ARTIFACT.workspace)) write('changes.diff', input.workspace.diff().patch);
  return directory;
}
