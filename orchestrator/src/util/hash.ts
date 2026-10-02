import { createHash } from 'node:crypto';

/**
 * JSON with object keys in sorted order, so two values that are equal produce the same text
 * regardless of the order their keys were written in. Hashes and the audit chain depend on this.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Content hash of any JSON-serializable value. */
export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Short form for display. Comparisons always use the full hash. */
export function short(hash: string): string {
  return hash.slice(0, 12);
}
