import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inTransaction, type Database } from './database.ts';

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * Applies `NNN_name.sql` files in order, each in its own transaction.
 * A migration that has already run must never change: its checksum is stored, and a mismatch
 * stops startup rather than letting the schema drift from what the files describe.
 */
export function migrate(db: Database, migrationsDir: string): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const files = readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();

  const findApplied = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?');
  const recordApplied = db.prepare(
    'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
  );

  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = findApplied.get(file) as { checksum: string } | undefined;

    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration ${file} was modified after it was applied. Add a new migration instead of editing an old one.`,
        );
      }
      result.alreadyApplied.push(file);
      continue;
    }

    inTransaction(db, () => {
      db.exec(sql);
      recordApplied.run(file, checksum, new Date().toISOString());
    });
    result.applied.push(file);
  }
  return result;
}
