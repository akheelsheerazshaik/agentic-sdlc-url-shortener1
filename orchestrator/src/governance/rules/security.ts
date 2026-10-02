import { posix } from 'node:path';
import type { Finding, PolicyRule } from '../policy.ts';
import { scanLines } from '../policy.ts';

/** The only places an agent may write. Everything else in the repository is out of bounds. */
export const WRITABLE_DIRECTORIES = ['src/', 'test/', 'migrations/', 'docs/'];
export const WRITABLE_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'openapi.yaml',
  'README.md',
  '.gitignore',
];

export function isContainedPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (posix.normalize(path) !== path) return false;
  if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return false;
  return true;
}

/** SEC-001: agents write only inside the service's source tree. */
export const pathContainment: PolicyRule = {
  id: 'SEC-001',
  category: 'SECURITY',
  description: 'Changes stay inside the workspace and inside the directories agents are allowed to write.',
  evaluate: ({ changes }) =>
    changes.flatMap((change): Finding[] => {
      const finding = (message: string): Finding[] => [
        { ruleId: 'SEC-001', category: 'SECURITY', severity: 'BLOCK', message, path: change.path },
      ];
      if (!isContainedPath(change.path)) return finding('path escapes the workspace or is not in normal form');
      const allowed =
        WRITABLE_ROOT_FILES.includes(change.path) || WRITABLE_DIRECTORIES.some((directory) => change.path.startsWith(directory));
      return allowed ? [] : finding('path is outside the directories agents may write to');
    }),
};

const SECRET_PATTERNS = [
  { pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, message: 'private key material' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, message: 'AWS access key id' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, message: 'API secret key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, message: 'GitHub token' },
  {
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\b['"]?\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    message: 'hard-coded credential',
  },
];

/** SEC-002: no credentials in the repository. */
export const noSecrets: PolicyRule = {
  id: 'SEC-002',
  category: 'SECURITY',
  description: 'No credentials or key material in any file.',
  evaluate: ({ changes }) =>
    changes.flatMap((change) =>
      scanLines(change, SECRET_PATTERNS, (message, line) => ({
        ruleId: 'SEC-002',
        category: 'SECURITY',
        severity: 'BLOCK',
        // The line number is reported, never the matched text, so the secret is not copied into logs.
        message: `${message} at line ${line}`,
        path: change.path,
      })),
    ),
};

const DANGEROUS_PATTERNS = [
  { pattern: /\beval\s*\(/, message: 'eval() executes arbitrary code' },
  { pattern: /\bnew\s+Function\s*\(/, message: 'new Function() executes arbitrary code' },
  { pattern: /['"](?:node:)?child_process['"]/, message: 'spawning processes is not allowed in the service' },
  { pattern: /\.(?:prepare|exec)\(\s*`[^`]*\$\{/, message: 'SQL built by string interpolation; use parameters' },
  { pattern: /\.(?:prepare|exec)\(\s*['"][^'"]*['"]\s*\+/, message: 'SQL built by string concatenation; use parameters' },
  { pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, message: 'TLS certificate verification disabled' },
];

/** SEC-003: constructs that turn data into code, or weaken transport security. */
export const noDangerousCode: PolicyRule = {
  id: 'SEC-003',
  category: 'SECURITY',
  description: 'No dynamic code execution, process spawning, injectable SQL or disabled TLS verification.',
  evaluate: ({ changes }) =>
    changes
      .filter((change) => /\.(?:ts|js|mjs|cjs)$/.test(change.path))
      .flatMap((change) =>
        scanLines(change, DANGEROUS_PATTERNS, (message, line) => ({
          ruleId: 'SEC-003',
          category: 'SECURITY',
          severity: 'BLOCK',
          message: `${message} (line ${line})`,
          path: change.path,
        })),
      ),
};

const INJECTION_PATTERNS = [
  /\bignore\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(?:instructions?|rules?|polic(?:y|ies))\b/i,
  /\bdisregard\b[^.\n]{0,40}\b(?:instructions?|rules?|polic(?:y|ies)|guardrails?)\b/i,
  /\b(?:skip|bypass|disable|turn off|remove)\b[^.\n]{0,40}\b(?:approvals?|tests?|polic(?:y|ies)|guardrails?|gates?|reviews?|audit)\b/i,
  /\byou are now\b|\bsystem prompt\b|\bact as (?:an? )?(?:admin|root|system)\b/i,
];

/**
 * SEC-004: requirement text and human comments are data. Text that tries to instruct the agents
 * to drop their controls is stopped before any model sees it.
 *
 * This is a screen, not the defence. The defence is that gates, policies and approvals run in
 * code outside the model, so text that slips past this check still cannot switch them off.
 */
export function screenUntrustedText(source: string, text: string): Finding[] {
  return INJECTION_PATTERNS.filter((pattern) => pattern.test(text)).map(() => ({
    ruleId: 'SEC-004',
    category: 'SECURITY' as const,
    severity: 'BLOCK' as const,
    message: `${source} contains text that tries to instruct the agents to bypass controls`,
  }));
}
