import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Design, Plan, RequirementSpec } from '../src/agents/schemas.ts';
import type { AgentDeps } from '../src/agents/support.ts';
import type { ApprovalRecord, StageContext } from '../src/engine/types.ts';
import { defaultPolicyEngine } from '../src/governance/rules/index.ts';
import type { ModelGateway } from '../src/model/gateway.ts';
import { CommandRunner } from '../src/tools/commandRunner.ts';
import { Workspace } from '../src/tools/workspace.ts';

export function tempDir(prefix = 'sdlc-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export const spec = (overrides: Partial<RequirementSpec> = {}): RequirementSpec => ({
  title: 'Link expiry',
  intent: 'Links can expire.',
  functionalRequirements: [
    { id: 'FR-1', statement: 'A link can expire.', priority: 'must', acceptanceCriteria: [{ id: 'AC-1.1', statement: 'An expired link returns 410.' }] },
  ],
  nonFunctionalRequirements: [{ id: 'NFR-1', category: 'compatibility', statement: 'Additive only.' }],
  ambiguities: [],
  assumptions: [],
  outOfScope: [],
  ...overrides,
});

export const plan = (overrides: Partial<Plan> = {}): Plan => ({
  approach: 'Schema, then code, then tests.',
  tasks: [
    { id: 'T-1', title: 'Add expiry', lane: 'code', description: 'd', dependsOn: [], requirementIds: ['FR-1'], files: ['src/links.ts'], risk: 'low' },
    { id: 'T-2', title: 'Test expiry', lane: 'test', description: 'd', dependsOn: ['T-1'], requirementIds: ['FR-1'], files: ['test/links.test.ts'], risk: 'low' },
    { id: 'T-3', title: 'Document expiry', lane: 'docs', description: 'd', dependsOn: [], requirementIds: ['FR-1'], files: ['README.md'], risk: 'low' },
  ],
  ...overrides,
});

export const design = (overrides: Partial<Design> = {}): Design => ({
  overview: 'Expiry is checked on resolve.',
  components: [{ name: 'Links', responsibility: 'Resolve links.', files: ['src/links.ts'] }],
  apiChanges: [],
  dataModelChanges: [],
  decisions: [{ id: 'ADR-1', title: 'Check on read', decision: 'Compare on resolve.', rationale: 'No extra query.', alternatives: ['Delete rows'] }],
  risks: [],
  requirementCoverage: [{ requirementId: 'FR-1', how: 'resolve() checks the expiry.' }],
  changeEnvelope: { schemaChange: false, apiChange: 'none', newDependencies: [], touchesPersonalData: false },
  ...overrides,
});

export interface TestDeps extends AgentDeps {
  approvalRecords: ApprovalRecord[];
}

/** Agent dependencies over a temporary run directory whose baseline holds the given files. */
export function testDeps(baseline: Record<string, string> = {}, model?: ModelGateway): TestDeps {
  const root = tempDir();
  const targetDir = join(root, 'target');
  const runDir = join(root, 'run');
  mkdirSync(targetDir, { recursive: true });
  writeTree(targetDir, baseline);
  const workspace = new Workspace(runDir);
  workspace.initialize(targetDir);
  const approvalRecords: ApprovalRecord[] = [];
  return {
    model: model ?? { id: 'none', generate: async () => { throw new Error('no model in this test'); } },
    workspace,
    policy: defaultPolicyEngine(),
    commands: new CommandRunner({}),
    runDir,
    targetDir,
    facts: { approvals: () => approvalRecords },
    approvalRecords,
  };
}

export function context(inputs: Record<string, unknown>, overrides: Partial<StageContext> = {}): StageContext {
  return {
    runId: 'run-1',
    stageId: 'stage',
    generation: 1,
    attempt: 1,
    usingFallback: false,
    inputs,
    feedback: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}
