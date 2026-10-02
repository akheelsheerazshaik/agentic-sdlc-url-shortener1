import {
  aliasTaken,
  codeSpaceExhausted,
  linkExpired,
  linkNotFound,
  validationError,
} from '../domain/errors.ts';
import { generateCode, validateAlias } from '../domain/shortCode.ts';
import { normalizeTargetUrl } from '../domain/urlPolicy.ts';
import type { LinkRecord, LinkRepository, NewLink } from './linkRepository.ts';

/** Longest lifetime a caller may ask for with `ttlSeconds`: five years. */
export const MAX_TTL_SECONDS = 5 * 365 * 24 * 60 * 60;

export interface CreateLinkInput {
  url: string;
  alias?: string | undefined;
  /** Absolute expiry instant. Mutually exclusive with `ttlSeconds`. */
  expiresAt?: string | undefined;
  /** Lifetime from now, in seconds. Mutually exclusive with `expiresAt`. */
  ttlSeconds?: number | undefined;
}

export interface Link {
  code: string;
  shortUrl: string;
  targetUrl: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface LinkServiceOptions {
  publicBaseUrl: string;
  now: () => Date;
  generateCode?: () => string;
  /** How many random codes to try before giving up. A clash is rare, so repeated clashes signal a real problem. */
  maxCodeAttempts?: number;
}

export class LinkService {
  private readonly repository: LinkRepository;
  private readonly publicBaseUrl: string;
  private readonly selfHost: string;
  private readonly now: () => Date;
  private readonly generate: () => string;
  private readonly maxCodeAttempts: number;

  constructor(repository: LinkRepository, options: LinkServiceOptions) {
    this.repository = repository;
    this.publicBaseUrl = options.publicBaseUrl;
    this.selfHost = new URL(options.publicBaseUrl).host;
    this.now = options.now;
    this.generate = options.generateCode ?? (() => generateCode());
    this.maxCodeAttempts = options.maxCodeAttempts ?? 5;
  }

  create(input: CreateLinkInput): Link {
    const now = this.now();
    const targetUrl = normalizeTargetUrl(input.url, { selfHost: this.selfHost });
    const expiresAt = resolveExpiry(input, now);
    const createdAt = now.toISOString();

    if (input.alias !== undefined) {
      const alias = validateAlias(input.alias);
      const link: NewLink = { code: alias, targetUrl, createdAt, expiresAt };
      // An expired alias stays taken. Reusing it would let someone else take over a link people already trust.
      if (!this.repository.insert(link)) throw aliasTaken(alias);
      return this.toLink(link);
    }

    // The primary key is the uniqueness check: insert and retry on a clash, with no read-then-write race.
    for (let attempt = 0; attempt < this.maxCodeAttempts; attempt++) {
      const link: NewLink = { code: this.generate(), targetUrl, createdAt, expiresAt };
      if (this.repository.insert(link)) return this.toLink(link);
    }
    throw codeSpaceExhausted();
  }

  /** Returns the stored link, expired or not, or throws a 404 error. */
  get(code: string): LinkRecord {
    const record = this.repository.findByCode(code);
    if (!record) throw linkNotFound(code);
    return record;
  }

  /** Returns a link that may be redirected to: throws 404 if unknown and 410 if expired. */
  resolve(code: string): LinkRecord {
    const record = this.get(code);
    if (isExpired(record, this.now())) throw linkExpired(code);
    return record;
  }

  toLink(link: NewLink): Link {
    return {
      code: link.code,
      shortUrl: `${this.publicBaseUrl}/${link.code}`,
      targetUrl: link.targetUrl,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
    };
  }
}

/** A link is expired from its expiry instant onwards. */
export function isExpired(link: Pick<LinkRecord, 'expiresAt'>, now: Date): boolean {
  return link.expiresAt !== null && now.getTime() >= new Date(link.expiresAt).getTime();
}

function resolveExpiry(input: CreateLinkInput, now: Date): string | null {
  if (input.expiresAt !== undefined && input.ttlSeconds !== undefined) {
    throw validationError('provide either expiresAt or ttlSeconds, not both.');
  }
  if (input.ttlSeconds !== undefined) {
    return new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
  }
  if (input.expiresAt !== undefined) {
    // Stored in UTC whatever offset the caller used.
    return new Date(input.expiresAt).toISOString();
  }
  return null;
}
