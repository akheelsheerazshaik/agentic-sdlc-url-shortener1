/**
 * Errors the service raises on purpose. Each one maps to an HTTP status and a stable machine-readable
 * `code`, and is rendered as an RFC 9457 problem document by the HTTP layer.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const validationError = (message: string): AppError =>
  new AppError(400, 'validation_error', message);

export const linkNotFound = (code: string): AppError =>
  new AppError(404, 'link_not_found', `No link exists for code "${code}".`);

export const linkExpired = (code: string): AppError =>
  new AppError(410, 'link_expired', `The link "${code}" has expired.`);

export const linkBlocked = (code: string): AppError =>
  new AppError(410, 'link_blocked', `The link "${code}" is no longer available.`);

export const aliasTaken = (alias: string): AppError =>
  new AppError(409, 'alias_taken', `The alias "${alias}" is already in use.`);

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError(429, 'rate_limited', 'Too many requests. Retry later.', {
    'retry-after': String(retryAfterSeconds),
  });

export const codeSpaceExhausted = (): AppError =>
  new AppError(503, 'code_generation_failed', 'Could not allocate a unique short code. Retry.');
