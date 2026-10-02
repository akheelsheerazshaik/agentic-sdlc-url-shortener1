import { randomInt } from 'node:crypto';
import { validationError } from './errors.ts';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 62^7 is about 3.5 trillion codes, so random codes are impractical to enumerate. */
export const CODE_LENGTH = 7;

/** Matches both generated codes and custom aliases; used to reject junk before touching the database. */
export const CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

/** Custom aliases are lowercase only, so "Promo" and "promo" can never be two different links. */
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Path segments the service uses itself; an alias must not shadow them. */
const RESERVED_ALIASES = new Set(['api', 'healthz', 'readyz', 'docs', 'admin', 'static', 'assets']);

export type RandomInt = (maxExclusive: number) => number;

/** Generates a random code from a cryptographically secure source, so codes are not guessable in sequence. */
export function generateCode(length: number = CODE_LENGTH, random: RandomInt = randomInt): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ALPHABET[random(ALPHABET.length)];
  }
  return code;
}

export function validateAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    throw validationError(
      'alias must be 3-32 characters of lowercase letters, digits, "-" or "_", and start with a letter or digit.',
    );
  }
  if (RESERVED_ALIASES.has(alias)) {
    throw validationError(`alias "${alias}" is reserved.`);
  }
  return alias;
}
