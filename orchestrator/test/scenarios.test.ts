import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLanePath } from '../src/agents/delivery.ts';
import {
  ARTIFACT,
  changeSetSchema,
  designSchema,
  impactReportSchema,
  planSchema,
  requirementSpecSchema,
  riskAssessmentSchema,
  testChangeSetSchema,
  type Lane,
} from '../src/agents/schemas.ts';
import { extractJson } from '../src/model/gateway.ts';
import { RecordedGateway } from '../src/model/recorded.ts';
import { loadScenario } from '../src/runtime.ts';
import { ambiguityLint, designCoversRequirements, openBlockingQuestions, planCoversRequirements, planStructure, specConsistency } from '../src/workflow/gates.ts';

/**
 * Static checks on the scenario recordings. They catch a recording that has drifted from the
 * schemas or from the gates without running a build, so a broken scenario fails in seconds here
 * rather than minutes into an end-to-end run.
 */
const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scenarios');
const scenarios = readdirSync(SCENARIOS_DIR).filter((name) => existsSync(join(SCENARIOS_DIR, name, 'scenario.json')));

const generations = (directory: string, stage: string): number[] =>
  readdirSync(directory)
    .map((entry) => new RegExp(`^${stage}\\.(\\d+)(\\.json)?$`).exec(entry)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort();

describe.each(scenarios)('scenario %s', (name) => {
  const directory = join(SCENARIOS_DIR, name);
  const recorded = join(directory, 'recorded');
  const gateway = new RecordedGateway(recorded);
  const scenario = loadScenario(directory);
  const reply = async (stage: string, generation: number): Promise<unknown> =>
    extractJson((await gateway.generate({ stageId: stage, generation, system: '', prompt: '' })).text);
  const latest = (stage: string): number => generations(recorded, stage).at(-1)!;

  it('has a requirement and a recording for every model-backed stage', () => {
    expect(scenario.requirement.text.length).toBeGreaterThan(20);
    for (const stage of ['requirements', 'planning', 'architecture', 'implementation', 'test-design', 'documentation', 'release-readiness']) {
      expect(generations(recorded, stage), stage).not.toEqual([]);
    }
    if (scenario.type !== 'greenfield') expect(generations(recorded, 'impact-analysis')).not.toEqual([]);
  });

  it('has specifications that match the schema and pass the requirement gates', async () => {
    for (const generation of generations(recorded, 'requirements')) {
      const spec = requirementSpecSchema.parse(await reply('requirements', generation));
      const lint = await ambiguityLint.check({ inputs: { [ARTIFACT.requirement]: scenario.requirement }, outputs: { [ARTIFACT.spec]: spec } });
      expect(lint.details, `requirements.${generation}`).toEqual(['every vague term in the requirement is addressed by a recorded ambiguity']);
      const consistency = await specConsistency.check({ inputs: {}, outputs: { [ARTIFACT.spec]: spec } });
      expect(consistency.passed, `requirements.${generation}: ${consistency.details.join('; ')}`).toBe(true);
    }
  });

  it('ends with a specification that has no open blocking question', async () => {
    const final = requirementSpecSchema.parse(await reply('requirements', latest('requirements')));
    expect(openBlockingQuestions(final)).toEqual([]);
  });

  it('has a final plan and design that cover the final specification', async () => {
    const spec = requirementSpecSchema.parse(await reply('requirements', latest('requirements')));
    const plan = planSchema.parse(await reply('planning', latest('planning')));
    const design = designSchema.parse(await reply('architecture', latest('architecture')));

    for (const gate of [planStructure, planCoversRequirements]) {
      const result = await gate.check({ inputs: { [ARTIFACT.spec]: spec }, outputs: { [ARTIFACT.plan]: plan } });
      expect(result.passed, `${gate.id}: ${result.details.join('; ')}`).toBe(true);
    }
    const result = await designCoversRequirements.check({ inputs: { [ARTIFACT.spec]: spec }, outputs: { [ARTIFACT.design]: design } });
    expect(result.passed, result.details.join('; ')).toBe(true);
  });

  it('has valid impact and risk recordings', async () => {
    if (scenario.type !== 'greenfield') impactReportSchema.parse(await reply('impact-analysis', 1));
    riskAssessmentSchema.parse(await reply('release-readiness', 1));
  });

  it('has change sets that stay in their lanes, cite tasks of the final plan, and prove every criterion', async () => {
    const spec = requirementSpecSchema.parse(await reply('requirements', latest('requirements')));
    const plan = planSchema.parse(await reply('planning', latest('planning')));
    const lanes: [string, Lane][] = [['implementation', 'code'], ['test-design', 'test'], ['documentation', 'docs']];
    const delivered = new Set<string>();

    for (const [stage, lane] of lanes) {
      for (const generation of generations(recorded, stage)) {
        const changeSet = (lane === 'test' ? testChangeSetSchema : changeSetSchema).parse(await reply(stage, generation));
        const laneTasks = new Set(plan.tasks.filter((task) => task.lane === lane).map((task) => task.id));
        for (const change of changeSet.changes) {
          expect(isLanePath(lane, change.path), `${stage}.${generation}: ${change.path}`).toBe(true);
          for (const taskId of change.taskIds) {
            expect(laneTasks.has(taskId), `${stage}.${generation}: ${change.path} cites ${taskId}`).toBe(true);
            delivered.add(taskId);
          }
        }
      }
    }
    expect([...delivered].sort()).toEqual(plan.tasks.map((task) => task.id).sort());

    const tests = testChangeSetSchema.parse(await reply('test-design', latest('test-design')));
    const criteria = spec.functionalRequirements.flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => criterion.id));
    expect(tests.coverage.map((entry) => entry.criterionId).sort()).toEqual(criteria.sort());
  });
});
