import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.ts';
import { migrate } from '../../src/db/migrator.ts';
import { MIGRATIONS_DIR } from '../helpers.ts';

function tempMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe('migrate', () => {
  it('applies the real migrations once and is a no-op the second time', () => {
    const db = openDatabase(':memory:');
    const first = migrate(db, MIGRATIONS_DIR);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.applied[0]).toBe('001_init.sql');

    const second = migrate(db, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
  });

  it('applies files in numeric order and ignores files that are not migrations', () => {
    const dir = tempMigrations({
      '002_add_column.sql': 'ALTER TABLE t ADD COLUMN b TEXT;',
      '001_create.sql': 'CREATE TABLE t (a TEXT);',
      'notes.txt': 'not sql',
    });
    const db = openDatabase(':memory:');
    expect(migrate(db, dir).applied).toEqual(['001_create.sql', '002_add_column.sql']);
  });

  it('refuses to start when an applied migration has been edited', () => {
    const dir = tempMigrations({ '001_create.sql': 'CREATE TABLE t (a TEXT);' });
    const db = openDatabase(':memory:');
    migrate(db, dir);
    writeFileSync(join(dir, '001_create.sql'), 'CREATE TABLE t (a TEXT, b TEXT);');
    expect(() => migrate(db, dir)).toThrowError(/modified after it was applied/);
  });

  it('rolls back a migration that fails part-way and does not record it', () => {
    const dir = tempMigrations({
      '001_broken.sql': 'CREATE TABLE ok (a TEXT); CREATE TABLE ok (a TEXT);',
    });
    const db = openDatabase(':memory:');
    expect(() => migrate(db, dir)).toThrowError();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all();
    expect(tables).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
  });
});
