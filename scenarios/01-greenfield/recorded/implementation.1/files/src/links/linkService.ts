import { aliasTaken, codeSpaceExhausted, linkNotFound } from '../domain/errors.ts';
import { generateCode, validateAlias } from '../domain/shortCode.ts';
import { normalizeTargetUrl } from '../domain/urlPolicy.ts';
import type { LinkRecord, LinkRepository } from './linkRepository.ts';

export interface CreateLinkInput {
  url: string;
  alias?: string | undefined;
}

export interface Link {
  code: string;
  shortUrl: string;
  targetUrl: string;
  createdAt: string;
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
    const targetUrl = normalizeTargetUrl(input.url, { selfHost: this.selfHost });
    const createdAt = this.now().toISOString();

    if (input.alias !== undefined) {
      const alias = validateAlias(input.alias);
      if (!this.repository.insert({ code: alias, targetUrl, createdAt })) {
        throw aliasTaken(alias);
      }
      return this.toLink({ code: alias, targetUrl, createdAt });
    }

    // The primary key is the uniqueness check: insert and retry on a clash, with no read-then-write race.
    for (let attempt = 0; attempt < this.maxCodeAttempts; attempt++) {
      const code = this.generate();
      if (this.repository.insert({ code, targetUrl, createdAt })) {
        return this.toLink({ code, targetUrl, createdAt });
      }
    }
    throw codeSpaceExhausted();
  }

  /** Returns the stored link or throws a 404 error. */
  get(code: string): LinkRecord {
    const record = this.repository.findByCode(code);
    if (!record) throw linkNotFound(code);
    return record;
  }

  shortUrlFor(code: string): string {
    return `${this.publicBaseUrl}/${code}`;
  }

  private toLink(link: { code: string; targetUrl: string; createdAt: string }): Link {
    return { ...link, shortUrl: this.shortUrlFor(link.code) };
  }
}
