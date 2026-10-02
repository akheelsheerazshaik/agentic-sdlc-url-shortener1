import type { StatementSync } from 'node:sqlite';
import type { Database } from '../db/database.ts';

export interface LinkRecord {
  code: string;
  targetUrl: string;
  createdAt: string;
  /** ISO-8601 UTC instant after which the link no longer redirects, or null if it never expires. */
  expiresAt: string | null;
  clickCount: number;
}

export type NewLink = Pick<LinkRecord, 'code' | 'targetUrl' | 'createdAt' | 'expiresAt'>;

interface LinkRow {
  code: string;
  target_url: string;
  created_at: string;
  expires_at: string | null;
  click_count: number;
}

/** The only place that knows how links are stored. Every statement is parameterized. */
export class LinkRepository {
  private readonly insertStatement: StatementSync;
  private readonly findStatement: StatementSync;

  constructor(db: Database) {
    this.insertStatement = db.prepare(
      'INSERT INTO links (code, target_url, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING',
    );
    this.findStatement = db.prepare(
      'SELECT code, target_url, created_at, expires_at, click_count FROM links WHERE code = ?',
    );
  }

  /** Inserts the link. Returns false if the code is already taken, so the caller decides what a clash means. */
  insert(link: NewLink): boolean {
    const result = this.insertStatement.run(link.code, link.targetUrl, link.createdAt, link.expiresAt);
    return Number(result.changes) === 1;
  }

  findByCode(code: string): LinkRecord | undefined {
    const row = this.findStatement.get(code) as LinkRow | undefined;
    if (!row) return undefined;
    return {
      code: row.code,
      targetUrl: row.target_url,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      clickCount: row.click_count,
    };
  }
}
