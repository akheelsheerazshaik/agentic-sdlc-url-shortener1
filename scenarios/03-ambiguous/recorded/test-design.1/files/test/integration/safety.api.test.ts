import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.ts';
import { createLink, createTestApp, type TestApp } from '../helpers.ts';

describe('destination safety', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.app.close();
  });

  describe('when creating a link', () => {
    it.each([
      ['a denied host', 'https://malware.example/payload'],
      ['a subdomain of a denied host', 'https://files.malware.example/payload'],
      ['a denied host in another letter case', 'https://MALWARE.example/'],
      ['a private network address', 'http://192.168.1.1/admin'],
      ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
      ['a loopback address written as an integer', 'http://2130706433/'],
      ['an IPv6 loopback address', 'http://[::1]:8080/'],
      ['localhost', 'http://localhost:9200/_cat/indices'],
      ['an internal host name', 'http://jenkins.corp.internal/'],
      ['a single-label host name', 'http://intranet/wiki'],
    ])('rejects %s with 400', async (_label, url) => {
      t = createTestApp({ env: { DENIED_HOSTS: 'malware.example' } });
      const { status, body } = await createLink(t.app, { url });
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: 'validation_error', detail: 'url points to a destination that is not allowed.' });
    });

    it('accepts public destinations that are not denied', async () => {
      t = createTestApp({ env: { DENIED_HOSTS: 'malware.example' } });
      expect((await createLink(t.app, { url: 'https://example.com/page' })).status).toBe(201);
      expect((await createLink(t.app, { url: 'https://notmalware.example/' })).status).toBe(201);
      expect((await createLink(t.app, { url: 'http://93.184.216.34/' })).status).toBe(201);
    });
  });

  describe('when redirecting', () => {
    it('blocks an existing link once its host is added to the denylist', async () => {
      // The same database, first without and then with the host on the denylist, as after a config change.
      const db = openDatabase(':memory:');
      const before = createTestApp({ db });
      await createLink(before.app, { url: 'https://later-bad.example/landing', alias: 'old-link' });
      expect((await before.app.inject({ method: 'GET', url: '/old-link' })).statusCode).toBe(302);
      await before.app.close();

      t = createTestApp({ db, env: { DENIED_HOSTS: 'later-bad.example' } });
      const response = await t.app.inject({ method: 'GET', url: '/old-link' });
      expect(response.statusCode).toBe(410);
      expect(response.headers.location).toBeUndefined();
      expect(response.json()).toMatchObject({ status: 410, code: 'link_blocked' });
    });

    it('does not record a click or reveal the destination for a blocked link', async () => {
      const db = openDatabase(':memory:');
      const before = createTestApp({ db });
      await createLink(before.app, { url: 'https://later-bad.example/landing', alias: 'old-link' });
      await before.app.close();

      t = createTestApp({ db, env: { DENIED_HOSTS: 'later-bad.example' } });
      const response = await t.app.inject({ method: 'GET', url: '/old-link' });
      expect(response.body).not.toContain('later-bad.example');
      const stats = (await t.app.inject({ method: 'GET', url: '/api/v1/links/old-link/stats' })).json();
      expect(stats.totalClicks).toBe(0);
    });

    it('blocks a stored link that points at an internal address', async () => {
      t = createTestApp();
      t.db
        .prepare("INSERT INTO links (code, target_url, created_at) VALUES ('legacy-int', 'http://10.0.0.5/admin', '2025-01-01T00:00:00.000Z')")
        .run();
      const response = await t.app.inject({ method: 'GET', url: '/legacy-int' });
      expect(response.statusCode).toBe(410);
      expect(response.json().code).toBe('link_blocked');
    });
  });

  describe('configuration', () => {
    it('refuses to start with a malformed denylist', () => {
      expect(() => createTestApp({ env: { DENIED_HOSTS: 'https://malware.example' } })).toThrowError(
        /Invalid configuration: DENIED_HOSTS/,
      );
      t = createTestApp();
    });
  });
});
