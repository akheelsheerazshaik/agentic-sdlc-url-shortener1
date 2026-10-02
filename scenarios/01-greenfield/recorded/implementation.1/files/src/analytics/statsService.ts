import type { StatementSync } from 'node:sqlite';
import type { Database } from '../db/database.ts';
import type { ClickRecorder } from './clickRecorder.ts';

export interface LinkStats {
  code: string;
  totalClicks: number;
  /** One entry per UTC day that had clicks, within the reporting window, oldest first. */
  clicksByDay: { date: string; clicks: number }[];
  /** Most common referring hosts. Clicks without a referrer are reported as "direct". */
  topReferrers: { referrer: string; clicks: number }[];
}

export const STATS_WINDOW_DAYS = 30;
export const TOP_REFERRERS_LIMIT = 10;

export class StatsService {
  private readonly recorder: ClickRecorder;
  private readonly now: () => Date;
  private readonly totalStatement: StatementSync;
  private readonly byDayStatement: StatementSync;
  private readonly referrersStatement: StatementSync;

  constructor(db: Database, recorder: ClickRecorder, now: () => Date) {
    this.recorder = recorder;
    this.now = now;
    this.totalStatement = db.prepare('SELECT click_count FROM links WHERE code = ?');
    this.byDayStatement = db.prepare(`
      SELECT substr(clicked_at, 1, 10) AS date, COUNT(*) AS clicks
      FROM click_events
      WHERE code = ? AND clicked_at >= ?
      GROUP BY date
      ORDER BY date
    `);
    this.referrersStatement = db.prepare(`
      SELECT COALESCE(referrer_host, 'direct') AS referrer, COUNT(*) AS clicks
      FROM click_events
      WHERE code = ?
      GROUP BY referrer
      ORDER BY clicks DESC, referrer ASC
      LIMIT ?
    `);
  }

  /** Returns undefined when the link does not exist. */
  getStats(code: string): LinkStats | undefined {
    // Flush first so a caller sees the clicks this instance has already accepted.
    this.recorder.flush();

    const total = this.totalStatement.get(code) as { click_count: number } | undefined;
    if (!total) return undefined;

    const windowStart = new Date(this.now().getTime() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const clicksByDay = this.byDayStatement.all(code, windowStart.toISOString()) as {
      date: string;
      clicks: number;
    }[];
    const topReferrers = this.referrersStatement.all(code, TOP_REFERRERS_LIMIT) as {
      referrer: string;
      clicks: number;
    }[];

    return {
      code,
      totalClicks: total.click_count,
      clicksByDay: clicksByDay.map((row) => ({ date: row.date, clicks: row.clicks })),
      topReferrers: topReferrers.map((row) => ({ referrer: row.referrer, clicks: row.clicks })),
    };
  }
}
