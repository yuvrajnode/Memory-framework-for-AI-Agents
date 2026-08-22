import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { MemoryEngine } from '@mnemos/core';
import { registerAuth } from './auth.js';
import type { ServerConfig } from './config.js';
import { registerErrorHandler } from './errors.js';
import { openapiDocument } from './openapi.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMemoryRoutes } from './routes/memories.js';

/** Build the HTTP app around an already-initialised engine. */
export async function buildApp(
  engine: MemoryEngine,
  config: ServerConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Pretty output is a dev nicety; production wants parseable JSON lines.
      ...(config.nodeEnv === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    },
    bodyLimit: config.bodyLimitBytes,
    trustProxy: true,
    // Per-request logging is noise in production, where the access log belongs
    // to the proxy in front of this service. Fastify 5 moved the switch onto
    // a LogController instance; the deprecated top-level flag is avoided so
    // this does not break on Fastify 6.
    logController: new LogController({
      disableRequestLogging: config.nodeEnv === 'production',
    }),
  });

  await app.register(helmet, {
    // The API serves JSON only; CSP belongs to whatever serves the dashboard.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key'],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    // Health checks come from orchestrators on a fixed schedule and must
    // never be throttled out of existence.
    allowList: (request) => request.url === '/health' || request.url === '/ready',
    errorResponseBuilder: (_request, context) => ({
      error: 'TooManyRequests',
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
    }),
  });

  registerErrorHandler(app, config.nodeEnv === 'production');
  registerAuth(app, config.apiKey);

  app.get('/openapi.json', async () => openapiDocument);

  registerHealthRoutes(app, engine, config);
  registerMemoryRoutes(app, engine);
  registerAdminRoutes(app, engine);

  return app;
}
