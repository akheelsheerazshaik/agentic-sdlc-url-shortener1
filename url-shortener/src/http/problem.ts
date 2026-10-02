import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../domain/errors.ts';

/** RFC 9457 problem document. `code` is the stable identifier clients should branch on. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function problem(status: number, code: string, detail: string): Problem {
  return { type: `urn:problem:${code}`, title: TITLES[status] ?? 'Error', status, code, detail };
}

function send(reply: FastifyReply, body: Problem, headers: Record<string, string> = {}): FastifyReply {
  return reply
    .code(body.status)
    .headers(headers)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(JSON.stringify(body));
}

export function errorHandler(
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof AppError) {
    return send(reply, problem(error.status, error.code, error.message), error.headers);
  }

  // Errors Fastify raises for malformed requests (bad JSON, oversized body) carry a 4xx status.
  const status = 'statusCode' in error ? error.statusCode : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return send(reply, problem(status, 'bad_request', error.message));
  }

  // Anything else is a bug or an outage. Log the detail, return none of it.
  request.log.error({ err: error }, 'unhandled error');
  return send(reply, problem(500, 'internal_error', 'An unexpected error occurred.'));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return send(reply, problem(404, 'not_found', `No route for ${request.method} ${request.url.split('?')[0]}.`));
}
