import type { StatementSync } from 'node:sqlite';
import type { Database } from '../db/database.ts';

export interface LinkRecord {
  code: string;
  targetUrl: string;
  createdAt: string;
  clickCount: number;
}

interface LinkRow {
  code: string;
  target_url: string;
  created_at: string;
  click_count: number;
}

/** The only place that knows how links are stored. Every statement is parameterized. */
export class LinkRepository {
  private readonly insertStatement: StatementSync;
  private readonly findStatement: StatementSync;

  constructor(db: Database) {
    this.insertStatement = db.prepare(
      'INSERT INTO links (code, target_url, created_at) VALUES (?, ?, ?) ON CONFLICT (code) DO NOTHING',
    );
    this.findStatement = db.prepare(
      'SELECT code, target_url, created_at, click_count FROM links WHERE code = ?',
    );
  }

  /** Inserts the link. Returns false if the code is already taken, so the caller decides what a clash means. */
  insert(link: { code: string; targetUrl: string; createdAt: string }): boolean {
    const result = this.insertStatement.run(link.code, link.targetUrl, link.createdAt);
    return Number(result.changes) === 1;
  }

  findByCode(code: string): LinkRecord | undefined {
    const row = this.findStatement.get(code) as LinkRow | undefined;
    if (!row) return undefined;
    return {
      code: row.code,
      targetUrl: row.target_url,
      createdAt: row.created_at,
      clickCount: row.click_count,
    };
  }
}
