import { z } from 'zod';
import { parseDeniedHosts } from './domain/hostRules.ts';

/**
 * All runtime configuration comes from environment variables and is validated once at startup,
 * so a bad value fails the process immediately instead of surfacing as a runtime error later.
 */
const configSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** Base URL used to build the short links returned to clients. */
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  DATABASE_PATH: z.string().min(1).default('./data/shortener.db'),
  /** Comma-separated hosts that links may not point to. Subdomains of each host are denied too. */
  DENIED_HOSTS: z.string().default(''),
  /** Set only when running behind a trusted reverse proxy, so the client IP comes from X-Forwarded-For. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  /** Token bucket for the management API: burst size and sustained rate per client. */
  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().positive().default(1),
  /** Click events are buffered in memory and written in batches. */
  CLICK_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  CLICK_QUEUE_MAX: z.coerce.number().int().positive().default(10_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  host: string;
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  deniedHosts: string[];
  trustProxy: boolean;
  rateLimit: { capacity: number; refillPerSecond: number };
  clicks: { flushIntervalMs: number; queueMax: number };
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  let deniedHosts: string[];
  try {
    deniedHosts = parseDeniedHosts(e.DENIED_HOSTS);
  } catch (error) {
    throw new Error(`Invalid configuration: ${(error as Error).message}`);
  }
  return {
    host: e.HOST,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    databasePath: e.DATABASE_PATH,
    deniedHosts,
    trustProxy: e.TRUST_PROXY === 'true',
    rateLimit: { capacity: e.RATE_LIMIT_CAPACITY, refillPerSecond: e.RATE_LIMIT_REFILL_PER_SECOND },
    clicks: { flushIntervalMs: e.CLICK_FLUSH_INTERVAL_MS, queueMax: e.CLICK_QUEUE_MAX },
    logLevel: e.LOG_LEVEL,
  };
}
