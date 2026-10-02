import Fastify, { type FastifyInstance } from 'fastify';
import { ClickRecorder } from './analytics/clickRecorder.ts';
import { StatsService } from './analytics/statsService.ts';
import type { Config } from './config.ts';
import type { Database } from './db/database.ts';
import { rateLimited } from './domain/errors.ts';
import { errorHandler, notFoundHandler } from './http/problem.ts';
import { TokenBucketLimiter } from './http/rateLimiter.ts';
import { registerRoutes } from './http/routes.ts';
import { LinkRepository } from './links/linkRepository.ts';
import { LinkService } from './links/linkService.ts';

export interface AppOptions {
  config: Config;
  db: Database;
  /** Injectable clock and code generator, so tests control time and force code collisions. */
  now?: () => Date;
  generateCode?: () => string;
}

/**
 * Wires the service together. Everything the app needs is passed in, which is what lets the
 * integration tests run the whole HTTP stack against an in-memory database with no network.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const { config, db } = options;
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Log the method and path only. The default serializer also logs the client address.
      serializers: {
        req: (request) => ({ method: request.method, path: request.url.split('?')[0] }),
      },
    },
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
  });

  const links = new LinkService(new LinkRepository(db), {
    publicBaseUrl: config.publicBaseUrl,
    deniedHosts: config.deniedHosts,
    now,
    ...(options.generateCode ? { generateCode: options.generateCode } : {}),
  });
  const recorder = new ClickRecorder(db, {
    flushIntervalMs: config.clicks.flushIntervalMs,
    maxQueue: config.clicks.queueMax,
  });
  const stats = new StatsService(db, recorder, now);
  const limiter = new TokenBucketLimiter({
    capacity: config.rateLimit.capacity,
    refillPerSecond: config.rateLimit.refillPerSecond,
    now: () => now().getTime(),
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Limit the management API per client. Redirects are left unlimited: they are the product's hot
  // path and are cheap, while link creation is the abusable write.
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const decision = limiter.take(request.ip);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
  });

  registerRoutes(app, { db, links, stats, recorder, now });

  recorder.start((error) => app.log.error({ err: error }, 'click flush failed'));
  // Runs after in-flight requests finish and before the caller closes the database, so clicks
  // accepted during shutdown are written rather than discarded.
  app.addHook('onClose', async () => {
    try {
      recorder.close();
    } catch (error) {
      app.log.error({ err: error, lost: recorder.pending }, 'final click flush failed');
    }
  });

  return app;
}
