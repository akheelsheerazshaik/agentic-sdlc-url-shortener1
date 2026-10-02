import type { ChangeEnvelope, FileChange, Plan } from '../agents/schemas.ts';

/**
 * BLOCK: the change may not proceed. REQUIRE_APPROVAL: allowed only if a person has signed off on
 * exactly this kind of change. WARN: recorded for the reviewer, does not stop anything.
 */
export type Severity = 'BLOCK' | 'REQUIRE_APPROVAL' | 'WARN';
export type Category = 'SECURITY' | 'COMPLIANCE' | 'CHANGE_CONTROL' | 'QUALITY';

export interface Finding {
  ruleId: string;
  category: Category;
  severity: Severity;
  message: string;
  path?: string;
}

/** Everything a rule may look at when judging a proposed change. */
export interface ChangeReview {
  changes: FileChange[];
  /** Files that existed before the change, with a way to read them. */
  baselineFiles: ReadonlySet<string>;
  readBaseline: (path: string) => string | undefined;
  /** Present once the design has been approved. */
  envelope?: ChangeEnvelope | undefined;
  /** Present once the plan exists. */
  plan?: Plan | undefined;
}

export interface PolicyRule {
  id: string;
  category: Category;
  description: string;
  evaluate(review: ChangeReview): Finding[];
}

export interface PolicyLimits {
  maxChangedFiles: number;
  maxChangedLines: number;
}

/**
 * Policy as code. Rules are plain functions over the proposed change, so they give the same
 * answer every time and cannot be argued with by a model: no prompt reaches them.
 */
export class PolicyEngine {
  readonly rules: PolicyRule[];

  constructor(rules: PolicyRule[]) {
    const ids = new Set<string>();
    for (const rule of rules) {
      if (ids.has(rule.id)) throw new Error(`Duplicate policy rule id "${rule.id}".`);
      ids.add(rule.id);
    }
    this.rules = rules;
  }

  evaluate(review: ChangeReview, only?: readonly string[]): Finding[] {
    const selected = only ? this.rules.filter((rule) => only.includes(rule.id)) : this.rules;
    return selected.flatMap((rule) => rule.evaluate(review));
  }
}

export const blocking = (findings: Finding[]): Finding[] => findings.filter((finding) => finding.severity === 'BLOCK');

export const needingApproval = (findings: Finding[]): Finding[] =>
  findings.filter((finding) => finding.severity === 'REQUIRE_APPROVAL');

export function describeFinding(finding: Finding): string {
  return `${finding.ruleId} ${finding.severity}${finding.path ? ` ${finding.path}` : ''}: ${finding.message}`;
}

/** Shared helper for rules that scan file content line by line. */
export function scanLines(
  change: FileChange,
  patterns: { pattern: RegExp; message: string }[],
  make: (message: string, line: number) => Finding,
): Finding[] {
  if (change.content === undefined) return [];
  const findings: Finding[] = [];
  const lines = change.content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    for (const { pattern, message } of patterns) {
      if (pattern.test(lines[index]!)) findings.push(make(message, index + 1));
    }
  }
  return findings;
}
