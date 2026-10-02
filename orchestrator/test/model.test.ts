import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StageFailure } from '../src/engine/types.ts';
import { AnthropicGateway } from '../src/model/anthropic.ts';
import { extractJson, generateStructured, MeteredGateway, type ModelCallRecord, type ModelGateway } from '../src/model/gateway.ts';
import { RecordedGateway } from '../src/model/recorded.ts';

const signal = new AbortController().signal;
const request = { stageId: 'planning', generation: 1, system: 'system', prompt: 'prompt' };
const replying = (text: string): ModelGateway => ({ id: 'fake', generate: async () => ({ text, model: 'fake-1' }) });

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses a reply wrapped in a code fence', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('parses a reply with prose around the object', () => {
    expect(extractJson('Here is the plan:\n{"a": {"b": 2}}\nLet me know.')).toEqual({ a: { b: 2 } });
  });

  it('is not confused by code fences inside the JSON content', () => {
    const reply = JSON.stringify({ changes: [{ path: 'README.md', content: '# Title\n\n```bash\nnpm start\n```\n\n```json\n{"x": 1}\n```\n' }] });
    expect(extractJson(reply)).toEqual(JSON.parse(reply));
  });

  it.each([
    ['no object at all', 'I cannot help with that.'],
    ['broken JSON', '{"a": '],
    ['an array instead of an object', '[1, 2, 3]'],
  ])('rejects %s with a retryable failure', (_label, reply) => {
    expect(() => extractJson(reply)).toThrowError(StageFailure);
  });
});

describe('generateStructured', () => {
  const schema = z.object({ tasks: z.array(z.object({ id: z.string().regex(/^T-\d+$/) })).min(1) });

  it('returns the validated value', async () => {
    const value = await generateStructured(replying('{"tasks": [{"id": "T-1"}]}'), schema, request, signal);
    expect(value).toEqual({ tasks: [{ id: 'T-1' }] });
  });

  it('includes the JSON Schema in the prompt', async () => {
    let seen = '';
    const gateway: ModelGateway = { id: 'fake', generate: async (sent) => ((seen = sent.prompt), { text: '{"tasks": [{"id": "T-1"}]}', model: 'm' }) };
    await generateStructured(gateway, schema, request, signal);
    expect(seen).toContain('"tasks"');
    expect(seen).toContain('JSON Schema');
  });

  it('rejects a well-formed reply of the wrong shape, saying what is wrong', async () => {
    const attempt = generateStructured(replying('{"tasks": [{"id": "task one"}]}'), schema, request, signal);
    await expect(attempt).rejects.toThrowError(/does not match the required shape: tasks\.0\.id/);
    await expect(attempt).rejects.toMatchObject({ retryable: true });
  });
});

describe('MeteredGateway', () => {
  it('reports every call with hashes rather than content', async () => {
    const calls: ModelCallRecord[] = [];
    const gateway = new MeteredGateway(replying('{"secret": "do not log me"}'), (record) => calls.push(record));
    await gateway.generate(request, signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ gateway: 'fake', model: 'fake-1', stageId: 'planning', generation: 1 });
    expect(calls[0]!.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(calls)).not.toContain('do not log me');
  });

  it('does not count a call that failed', async () => {
    const calls: ModelCallRecord[] = [];
    const failing: ModelGateway = { id: 'fake', generate: async () => { throw new Error('down'); } };
    await expect(new MeteredGateway(failing, (record) => calls.push(record)).generate(request, signal)).rejects.toThrowError('down');
    expect(calls).toEqual([]);
  });
});

describe('RecordedGateway', () => {
  function recordings(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), 'recorded-'));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(directory, name, '..'), { recursive: true });
      writeFileSync(join(directory, name), content);
    }
    return directory;
  }

  it('replays the recording for the stage and generation', async () => {
    const gateway = new RecordedGateway(recordings({ 'planning.1.json': '{"v": 1}', 'planning.2.json': '{"v": 2}' }));
    expect((await gateway.generate({ ...request, generation: 1 })).text).toBe('{"v": 1}');
    expect((await gateway.generate({ ...request, generation: 2 })).text).toBe('{"v": 2}');
  });

  it('falls back to the latest earlier recording when a generation has none of its own', async () => {
    const gateway = new RecordedGateway(recordings({ 'planning.1.json': '{"v": 1}', 'planning.3.json': '{"v": 3}' }));
    expect((await gateway.generate({ ...request, generation: 2 })).text).toBe('{"v": 1}');
    expect((await gateway.generate({ ...request, generation: 9 })).model).toBe('recording:planning.3.json');
  });

  it('assembles a change set from a manifest and real files', async () => {
    const gateway = new RecordedGateway(
      recordings({
        'implementation.1/manifest.json': JSON.stringify({
          summary: 's',
          changes: [
            { path: 'src/a.ts', action: 'create', taskIds: ['T-1'] },
            { path: 'src/old.ts', action: 'delete', taskIds: ['T-1'] },
          ],
        }),
        'implementation.1/files/src/a.ts': 'export const a = 1;\n',
      }),
    );
    const reply = JSON.parse((await gateway.generate({ ...request, stageId: 'implementation' })).text);
    expect(reply).toEqual({
      summary: 's',
      changes: [
        { path: 'src/a.ts', action: 'create', taskIds: ['T-1'], content: 'export const a = 1;\n' },
        { path: 'src/old.ts', action: 'delete', taskIds: ['T-1'] },
      ],
    });
  });

  it('does not match a stage whose name merely starts the same way', async () => {
    const gateway = new RecordedGateway(recordings({ 'test-design.1.json': '{}' }));
    await expect(gateway.generate({ ...request, stageId: 'test' })).rejects.toThrowError(/no recorded reply/);
  });

  it('fails without retrying when nothing is recorded', async () => {
    const gateway = new RecordedGateway(recordings({}));
    await expect(gateway.generate(request)).rejects.toMatchObject({ retryable: false });
  });
});

describe('AnthropicGateway', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  /** A local stand-in for the API, so the HTTP contract is tested without a key or a network. */
  async function stub(respond: (body: any, headers: IncomingMessage['headers']) => { status: number; body: unknown }) {
    const requests: { body: any; headers: IncomingMessage['headers']; url: string | undefined }[] = [];
    const server = createServer((incoming, outgoing) => {
      let raw = '';
      incoming.on('data', (chunk) => (raw += chunk));
      incoming.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ body, headers: incoming.headers, url: incoming.url });
        const reply = respond(body, incoming.headers);
        outgoing.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => server.close();
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { requests, gateway: new AnthropicGateway({ apiKey: 'test-key', model: 'model-under-test', baseUrl }) };
  }

  it('sends the system prompt, the user prompt and the credentials, and returns the text', async () => {
    const { requests, gateway } = await stub(() => ({
      status: 200,
      body: { model: 'model-under-test', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: ' true}' }] },
    }));
    const response = await gateway.generate(request, signal);
    expect(response).toEqual({ text: '{"ok": true}', model: 'model-under-test' });
    expect(requests[0]!.url).toBe('/v1/messages');
    expect(requests[0]!.headers['x-api-key']).toBe('test-key');
    expect(requests[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(requests[0]!.body).toMatchObject({ model: 'model-under-test', system: 'system', messages: [{ role: 'user', content: 'prompt' }] });
  });

  it.each([
    [429, true],
    [500, true],
    [529, true],
    [400, false],
    [401, false],
  ])('treats HTTP %i as retryable=%s', async (status, retryable) => {
    const { gateway } = await stub(() => ({ status, body: { error: { message: 'nope' } } }));
    await expect(gateway.generate(request, signal)).rejects.toMatchObject({ retryable, message: `model returned HTTP ${status}: nope` });
  });

  it('never puts the API key in an error message', async () => {
    const { gateway } = await stub(() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }));
    const error = await gateway.generate(request, signal).catch((caught: Error) => caught);
    expect((error as Error).message).not.toContain('test-key');
  });

  it('refuses a reply that was cut off at the token limit', async () => {
    const { gateway } = await stub(() => ({ status: 200, body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a": ' }] } }));
    await expect(gateway.generate(request, signal)).rejects.toThrowError(/cut off at the token limit/);
  });

  it('reports a network failure as retryable', async () => {
    const gateway = new AnthropicGateway({ apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:9' });
    await expect(gateway.generate(request, signal)).rejects.toMatchObject({ retryable: true });
  });
});
