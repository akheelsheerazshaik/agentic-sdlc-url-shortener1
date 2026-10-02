import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT } from '../src/agents/schemas.ts';
import { AuditLog } from '../src/governance/audit.ts';
import { RecordedGateway } from '../src/model/recorded.ts';
import { createRun, DEFAULT_LIMITS, loadScenario, type RunHandle } from '../src/runtime.ts';
import { tempDir } from './fixtures.ts';

/**
 * Live mode, exercised without a real API key: a local HTTP server stands in for the model API.
 * These tests cover the wiring from the engine through the agents and the HTTP gateway, and what
 * happens when the model misbehaves or is unreachable. They do not show how good a real model's
 * answers are; only a run against a real model can show that.
 */
const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scenarios', '01-greenfield');

const STAGE_BY_ROLE: Record<string, string> = {
  'requirements analyst': 'requirements',
  'delivery planner': 'planning',
  'software architect': 'architecture',
};

let close: (() => void) | undefined;
afterEach(() => close?.());

/** Serves the greenfield recordings over the Messages API. `corrupt` lets a test damage chosen replies. */
async function stubModelApi(corrupt: (stage: string, call: number, text: string) => string = (_stage, _call, text) => text) {
  const recordings = new RecordedGateway(join(SCENARIO, 'recorded'));
  const prompts: { stage: string; prompt: string }[] = [];
  const calls = new Map<string, number>();
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      void (async () => {
        const body = JSON.parse(raw) as { system: string; messages: { content: string }[] };
        const role = Object.keys(STAGE_BY_ROLE).find((candidate) => body.system.includes(`You are the ${candidate}`))!;
        const stage = STAGE_BY_ROLE[role]!;
        const call = (calls.get(stage) ?? 0) + 1;
        calls.set(stage, call);
        prompts.push({ stage, prompt: body.messages[0]!.content });
        const { text } = await recordings.generate({ stageId: stage, generation: 1, system: '', prompt: '' });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'stub-model', stop_reason: 'end_turn', content: [{ type: 'text', text: corrupt(stage, call, text) }] }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = () => server.close();
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, prompts };
}

function liveRun(environment: Record<string, string>): RunHandle {
  const root = tempDir('live-');
  const scenario = loadScenario(SCENARIO);
  return createRun(
    join(root, 'runs'),
    'live-1',
    { scenarioId: scenario.id, scenarioDir: SCENARIO, targetDir: join(root, 'target'), mode: 'live', maxReworks: 2, faults: [], limits: DEFAULT_LIMITS },
    scenario.requirement,
    { environment },
  );
}

const modelCalls = (run: RunHandle) =>
  AuditLog.read(join(run.runDir, 'audit.jsonl'))
    .filter((event) => event.type === 'MODEL_CALLED')
    .map((event) => `${event.stageId}:${String(event.data.gateway)}`);

describe('live mode', () => {
  it('drives the stages through the model API and stops for design approval', async () => {
    const api = await stubModelApi();
    const run = liveRun({ ANTHROPIC_API_KEY: 'test-key', SDLC_MODEL: 'stub-model', ANTHROPIC_BASE_URL: api.baseUrl });
    await run.engine.run();

    expect(run.state.status).toBe('PAUSED');
    expect(run.state.stages.architecture!.status).toBe('AWAITING_APPROVAL');
    expect(modelCalls(run)).toEqual(['requirements:anthropic', 'planning:anthropic', 'architecture:anthropic']);
    expect(run.state.usage.modelCalls).toBe(3);
    expect(run.engine.artifacts.latest(ARTIFACT.plan)!.producedBy.actor).toBe('agent:planning');
    // The requirement reached the model as tagged data, with the schema it must answer in.
    expect(api.prompts[0]!.prompt).toContain('<requirement>\n# URL shortener service');
    expect(api.prompts[0]!.prompt).toContain('JSON Schema');
  });

  it('rejects a malformed reply, tells the model why, and accepts the corrected one', async () => {
    const api = await stubModelApi((stage, call, text) => (stage === 'planning' && call === 1 ? text.replace('"lane": "code"', '"lane": "backend"') : text));
    const run = liveRun({ ANTHROPIC_API_KEY: 'test-key', SDLC_MODEL: 'stub-model', ANTHROPIC_BASE_URL: api.baseUrl });
    await run.engine.run();

    expect(run.state.stages.planning).toMatchObject({ status: 'SUCCEEDED', attempts: 2, usedFallback: false });
    const failure = AuditLog.read(join(run.runDir, 'audit.jsonl')).find((event) => event.type === 'STAGE_ATTEMPT_FAILED')!;
    expect(failure.data.error).toMatch(/does not match the required shape: tasks\.0\.lane/);
  });

  it('feeds a gate rejection back into the next prompt', async () => {
    // First reply drops the test tasks, which the plan gate rejects.
    const api = await stubModelApi((stage, call, text) => {
      if (stage !== 'planning' || call !== 1) return text;
      const plan = JSON.parse(text) as { tasks: { lane: string }[] };
      return JSON.stringify({ ...plan, tasks: plan.tasks.filter((task) => task.lane !== 'test') });
    });
    const run = liveRun({ ANTHROPIC_API_KEY: 'test-key', SDLC_MODEL: 'stub-model', ANTHROPIC_BASE_URL: api.baseUrl });
    await run.engine.run();

    expect(run.state.stages.planning).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    const secondPrompt = api.prompts.filter((entry) => entry.stage === 'planning')[1]!.prompt;
    expect(secondPrompt).toContain('Your previous reply was rejected by an automated gate');
    expect(secondPrompt).toContain('the plan has no test task');
  });

  it('falls back to the recordings when the model API is unreachable', async () => {
    const run = liveRun({ ANTHROPIC_API_KEY: 'test-key', SDLC_MODEL: 'stub-model', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
    await run.engine.run();

    expect(run.state.status).toBe('PAUSED');
    expect(run.state.stages.requirements).toMatchObject({ status: 'SUCCEEDED', usedFallback: true, attempts: 3 });
    expect(modelCalls(run)).toEqual(['requirements:recorded', 'planning:recorded', 'architecture:recorded']);
  });

  it('refuses to start without a key and an explicitly chosen model', () => {
    expect(() => liveRun({ ANTHROPIC_API_KEY: 'test-key' })).toThrowError(/needs ANTHROPIC_API_KEY and SDLC_MODEL/);
    expect(() => liveRun({ SDLC_MODEL: 'some-model' })).toThrowError(/needs ANTHROPIC_API_KEY and SDLC_MODEL/);
  });
});
