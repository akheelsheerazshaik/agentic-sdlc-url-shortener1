import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/database.ts';
import { migrate } from '../src/db/migrator.ts';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** A clock the test moves by hand, so time-dependent behaviour is deterministic. */
export class FakeClock {
  private current: number;

  constructor(start = '2026-03-01T12:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now = (): Date => new Date(this.current);

  advance(ms: number): void {
    this.current += ms;
  }
}

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  clock: FakeClock;
  config: Config;
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_PATH: ':memory:',
    PUBLIC_BASE_URL: 'https://sho.rt',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_CAPACITY: '100',
    ...env,
  });
}

/** Builds the full app on an in-memory database. Requests go through `app.inject`, with no socket. */
export function createTestApp(
  options: { env?: Record<string, string>; generateCode?: () => string; db?: Database } = {},
): TestApp {
  const config = testConfig(options.env);
  const db = options.db ?? openDatabase(config.databasePath);
  migrate(db, MIGRATIONS_DIR);
  const clock = new FakeClock();
  const app = buildApp({
    config,
    db,
    now: clock.now,
    ...(options.generateCode ? { generateCode: options.generateCode } : {}),
  });
  return { app, db, clock, config };
}

export async function createLink(
  app: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/links', payload: body });
  return { status: response.statusCode, body: response.json() };
}
