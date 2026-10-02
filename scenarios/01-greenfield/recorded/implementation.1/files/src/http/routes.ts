import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { referrerHost, type ClickRecorder } from '../analytics/clickRecorder.ts';
import type { StatsService } from '../analytics/statsService.ts';
import type { Database } from '../db/database.ts';
import { linkNotFound, validationError } from '../domain/errors.ts';
import { CODE_PATTERN } from '../domain/shortCode.ts';
import type { LinkService } from '../links/linkService.ts';

export interface RouteDependencies {
  db: Database;
  links: LinkService;
  stats: StatsService;
  recorder: ClickRecorder;
  now: () => Date;
}

const createLinkBody = z.strictObject({
  url: z.string().min(1),
  alias: z.string().optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw validationError(detail);
  }
  return result.data;
}

/** Rejects malformed codes before they reach the database, and treats them as unknown links. */
function codeParam(params: unknown): string {
  const code = (params as { code?: string }).code ?? '';
  if (!CODE_PATTERN.test(code)) throw linkNotFound(code);
  return code;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { db, links, stats, recorder, now } = deps;

  app.post('/api/v1/links', async (request, reply) => {
    const body = parseBody(createLinkBody, request.body);
    const link = links.create(body);
    return reply.code(201).header('location', `/api/v1/links/${link.code}`).send(link);
  });

  app.get('/api/v1/links/:code', async (request) => {
    const record = links.get(codeParam(request.params));
    return {
      code: record.code,
      shortUrl: links.shortUrlFor(record.code),
      targetUrl: record.targetUrl,
      createdAt: record.createdAt,
    };
  });

  app.get('/api/v1/links/:code/stats', async (request) => {
    const code = codeParam(request.params);
    const result = stats.getStats(code);
    if (!result) throw linkNotFound(code);
    return result;
  });

  app.get('/:code', async (request, reply) => {
    const code = codeParam(request.params);
    const record = links.get(code);
    recorder.record({
      code,
      clickedAt: now().toISOString(),
      referrerHost: referrerHost(request.headers.referer),
    });
    // 302 with no-store: browsers must ask every time, so each click is counted and a link can change later.
    return reply
      .code(302)
      .header('location', record.targetUrl)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send();
  });

  /** Liveness: the process is up. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Readiness: the process can serve traffic, which requires the database. */
  app.get('/readyz', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
