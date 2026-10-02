import type { Finding, PolicyRule } from '../policy.ts';
import { scanLines } from '../policy.ts';

/** A column definition whose name says it holds personal data, wherever it appears in a CREATE or ALTER statement. */
const PERSONAL_DATA_COLUMN =
  /(?:^|\bADD\s+COLUMN|[(,])\s*["`]?(?:ip|ip_address|client_ip|remote_addr|user_agent|email|phone|full_name|visitor_id|device_id)["`]?\s+(?:TEXT|INTEGER|BLOB|REAL|VARCHAR|CHAR)\b/i;

const PERSONAL_DATA_LOGGING = [
  {
    pattern: /\blog\.\w+\([^)]*(?:\.ip\b|remoteAddress|['"]user-agent['"]|\.referer\b|\.cookie\b|\.authorization\b)/,
    message: 'request data that can identify a person is written to the log',
  },
];

/**
 * CMP-001: no personal data at rest or in logs without a privacy review.
 * Storing a client address or a raw User-Agent turns anonymous click counts into a record of
 * what identifiable people did, which is a different legal and security position.
 */
export const noPersonalData: PolicyRule = {
  id: 'CMP-001',
  category: 'COMPLIANCE',
  description: 'No personal data (client address, User-Agent, contact details, visitor identifiers) stored or logged.',
  evaluate: ({ changes }) =>
    changes.flatMap((change): Finding[] => {
      const make = (message: string, line: number): Finding => ({
        ruleId: 'CMP-001',
        category: 'COMPLIANCE',
        severity: 'BLOCK',
        message: `${message} (line ${line})`,
        path: change.path,
      });
      if (/^migrations\/.+\.sql$/.test(change.path)) {
        return scanLines(
          change,
          [{ pattern: PERSONAL_DATA_COLUMN, message: 'column stores personal data; store a derived, non-identifying value instead' }],
          make,
        );
      }
      if (/^src\/.+\.ts$/.test(change.path)) return scanLines(change, PERSONAL_DATA_LOGGING, make);
      return [];
    }),
};

/**
 * CMP-002: every change traces to a planned task, and every planned task is delivered.
 * An untraceable change is work nobody asked for; an undelivered task is a requirement that
 * silently went missing.
 */
export const traceability: PolicyRule = {
  id: 'CMP-002',
  category: 'COMPLIANCE',
  description: 'Every file change cites a task in the plan, and every task in the plan has at least one change.',
  evaluate: ({ changes, plan }) => {
    if (!plan) return [];
    const findings: Finding[] = [];
    const known = new Set(plan.tasks.map((task) => task.id));
    const delivered = new Set<string>();

    for (const change of changes) {
      for (const taskId of change.taskIds) {
        if (known.has(taskId)) {
          delivered.add(taskId);
        } else {
          findings.push({
            ruleId: 'CMP-002',
            category: 'COMPLIANCE',
            severity: 'BLOCK',
            message: `cites task ${taskId}, which is not in the plan`,
            path: change.path,
          });
        }
      }
    }
    for (const task of plan.tasks) {
      if (!delivered.has(task.id)) {
        findings.push({
          ruleId: 'CMP-002',
          category: 'COMPLIANCE',
          severity: 'BLOCK',
          message: `planned task ${task.id} ("${task.title}") has no change that delivers it`,
        });
      }
    }
    return findings;
  },
};
