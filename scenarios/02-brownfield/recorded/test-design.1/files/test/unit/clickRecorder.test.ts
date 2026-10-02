import { describe, expect, it } from 'vitest';
import { ClickRecorder, referrerHost } from '../../src/analytics/clickRecorder.ts';
import { openDatabase } from '../../src/db/database.ts';
import { migrate } from '../../src/db/migrator.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

function setup(maxQueue = 100) {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  db.prepare("INSERT INTO links (code, target_url, created_at) VALUES ('abc1234', 'https://example.com/', '2026-03-01T00:00:00.000Z')").run();
  const recorder = new ClickRecorder(db, { flushIntervalMs: 60_000, maxQueue });
  const click = (referrer: string | null = null) =>
    recorder.record({ code: 'abc1234', clickedAt: '2026-03-01T12:00:00.000Z', referrerHost: referrer });
  const count = () =>
    (db.prepare("SELECT click_count FROM links WHERE code = 'abc1234'").get() as { click_count: number }).click_count;
  const events = () => (db.prepare('SELECT COUNT(*) AS n FROM click_events').get() as { n: number }).n;
  return { db, recorder, click, count, events };
}

describe('ClickRecorder', () => {
  it('buffers clicks and writes nothing until flushed', () => {
    const { recorder, click, count, events } = setup();
    click();
    click();
    expect(recorder.pending).toBe(2);
    expect(count()).toBe(0);
    expect(events()).toBe(0);
  });

  it('writes the events and the running total together on flush', () => {
    const { recorder, click, count, events } = setup();
    click('news.example');
    click();
    click();
    expect(recorder.flush()).toBe(3);
    expect(recorder.pending).toBe(0);
    expect(count()).toBe(3);
    expect(events()).toBe(3);
  });

  it('drops clicks beyond the queue bound and counts them', () => {
    const { recorder, click, count } = setup(2);
    click();
    click();
    click();
    expect(recorder.pending).toBe(2);
    expect(recorder.dropped).toBe(1);
    recorder.flush();
    expect(count()).toBe(2);
  });

  it('flushes what is buffered when closed', () => {
    const { recorder, click, count } = setup();
    click();
    click();
    expect(recorder.close()).toBe(2);
    expect(count()).toBe(2);
    expect(recorder.pending).toBe(0);
  });

  it('keeps the batch and leaves the database untouched when a flush fails', () => {
    const { recorder, click, count, events } = setup();
    click();
    // A click for a code with no link violates the foreign key, so the whole batch must roll back.
    recorder.record({ code: 'missing', clickedAt: '2026-03-01T12:00:00.000Z', referrerHost: null });
    expect(() => recorder.flush()).toThrowError();
    expect(recorder.pending).toBe(2);
    expect(count()).toBe(0);
    expect(events()).toBe(0);
  });
});

describe('referrerHost', () => {
  it('keeps only the host of a referrer URL', () => {
    expect(referrerHost('https://News.Example/article?user=alice@example.com')).toBe('news.example');
  });

  it('returns null for a missing or malformed header', () => {
    expect(referrerHost(undefined)).toBeNull();
    expect(referrerHost('')).toBeNull();
    expect(referrerHost('not a url')).toBeNull();
  });
});
