import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLink, createTestApp, type TestApp } from '../helpers.ts';

describe('links API', () => {
  let t: TestApp;
  beforeEach(() => {
    t = createTestApp();
  });
  afterEach(async () => {
    await t.app.close();
  });

  describe('POST /api/v1/links', () => {
    it('creates a link with a generated code', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/links',
        payload: { url: 'https://example.com/landing?utm=1' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.code).toMatch(/^[0-9A-Za-z]{7}$/);
      expect(body).toEqual({
        code: body.code,
        shortUrl: `https://sho.rt/${body.code}`,
        targetUrl: 'https://example.com/landing?utm=1',
        createdAt: '2026-03-01T12:00:00.000Z',
      });
      expect(response.headers.location).toBe(`/api/v1/links/${body.code}`);
    });

    it('creates a link with a custom alias', async () => {
      const { status, body } = await createLink(t.app, { url: 'https://example.com', alias: 'spring-sale' });
      expect(status).toBe(201);
      expect(body.code).toBe('spring-sale');
      expect(body.shortUrl).toBe('https://sho.rt/spring-sale');
    });

    it('returns 409 when the alias is already taken', async () => {
      await createLink(t.app, { url: 'https://example.com/a', alias: 'promo' });
      const { status, body } = await createLink(t.app, { url: 'https://example.com/b', alias: 'promo' });
      expect(status).toBe(409);
      expect(body.code).toBe('alias_taken');
    });

    it.each([
      ['missing url', {}],
      ['empty url', { url: '' }],
      ['non-http scheme', { url: 'javascript:alert(1)' }],
      ['credentials in url', { url: 'https://user:pass@example.com' }],
      ['link to itself', { url: 'https://sho.rt/abc' }],
      ['invalid alias', { url: 'https://example.com', alias: 'No Spaces' }],
      ['reserved alias', { url: 'https://example.com', alias: 'api' }],
      ['unknown field', { url: 'https://example.com', admin: true }],
      ['wrong type', { url: 42 }],
    ])('returns a 400 problem document for %s', async (_label, payload) => {
      const response = await t.app.inject({ method: 'POST', url: '/api/v1/links', payload });
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status: 400, code: 'validation_error' });
    });

    it('returns a 400 problem document for malformed JSON', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/links',
        headers: { 'content-type': 'application/json' },
        payload: '{"url": ',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('rejects bodies over the size limit', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/links',
        payload: { url: `https://example.com/${'a'.repeat(20_000)}` },
      });
      expect(response.statusCode).toBe(413);
    });

    it('retries with a new code when a generated code collides', async () => {
      await t.app.close();
      const codes = ['taken01', 'taken01', 'fresh02'];
      t = createTestApp({ generateCode: () => codes.shift()! });
      const first = await createLink(t.app, { url: 'https://example.com/1' });
      const second = await createLink(t.app, { url: 'https://example.com/2' });
      expect(first.body.code).toBe('taken01');
      expect(second.status).toBe(201);
      expect(second.body.code).toBe('fresh02');
    });

    it('returns 503 instead of looping forever when no unique code can be found', async () => {
      await t.app.close();
      t = createTestApp({ generateCode: () => 'samecode' });
      await createLink(t.app, { url: 'https://example.com/1' });
      const { status, body } = await createLink(t.app, { url: 'https://example.com/2' });
      expect(status).toBe(503);
      expect(body.code).toBe('code_generation_failed');
    });
  });

  describe('GET /api/v1/links/:code', () => {
    it('returns the link', async () => {
      const created = await createLink(t.app, { url: 'https://example.com/x', alias: 'lookup' });
      const response = await t.app.inject({ method: 'GET', url: '/api/v1/links/lookup' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(created.body);
    });

    it('returns 404 for an unknown code', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/api/v1/links/nothere' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ status: 404, code: 'link_not_found' });
    });
  });

  describe('GET /:code', () => {
    it('redirects to the target with 302 and no caching', async () => {
      await createLink(t.app, { url: 'https://example.com/landing', alias: 'go-here' });
      const response = await t.app.inject({ method: 'GET', url: '/go-here' });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('https://example.com/landing');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });

    it('returns 404 for an unknown code', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/unknown1' });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('link_not_found');
    });

    it.each(['/a', '/has.dot', '/%00%00%00', `/${'a'.repeat(40)}`])(
      'returns 404 for the malformed code %s without querying for it',
      async (path) => {
        const response = await t.app.inject({ method: 'GET', url: path });
        expect(response.statusCode).toBe(404);
      },
    );

    it('treats codes as case sensitive', async () => {
      await createLink(t.app, { url: 'https://example.com', alias: 'lower' });
      expect((await t.app.inject({ method: 'GET', url: '/LOWER' })).statusCode).toBe(404);
    });
  });

  it('returns a 404 problem document for unknown routes', async () => {
    const response = await t.app.inject({ method: 'DELETE', url: '/api/v1/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('sets nosniff on every response', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
