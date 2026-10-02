import type { Finding, PolicyLimits, PolicyRule } from '../policy.ts';

const MIGRATION = /^migrations\/(\d{3})_[a-z0-9_]+\.sql$/;

const finding = (ruleId: string, severity: Finding['severity'], message: string, path?: string): Finding => ({
  ruleId,
  category: 'CHANGE_CONTROL',
  severity,
  message,
  ...(path !== undefined ? { path } : {}),
});

/**
 * CHG-001: schema changes are append-only and numbered.
 * A migration that has run somewhere must never change, so the only allowed schema change is a
 * new file with the next number.
 */
export const migrationDiscipline: PolicyRule = {
  id: 'CHG-001',
  category: 'CHANGE_CONTROL',
  description: 'Existing migrations are immutable; a schema change is a new migration with the next number.',
  evaluate: ({ changes, baselineFiles }) => {
    const findings: Finding[] = [];
    const existing = [...baselineFiles].filter((path) => MIGRATION.test(path));
    let highest = Math.max(0, ...existing.map((path) => Number(MIGRATION.exec(path)![1])));

    const migrations = changes.filter((change) => change.path.startsWith('migrations/')).sort((a, b) => a.path.localeCompare(b.path));
    for (const change of migrations) {
      if (baselineFiles.has(change.path)) {
        findings.push(finding('CHG-001', 'BLOCK', 'an existing migration may not be edited or deleted; add a new one', change.path));
        continue;
      }
      const match = MIGRATION.exec(change.path);
      if (!match) {
        findings.push(finding('CHG-001', 'BLOCK', 'migration file name must be NNN_lower_snake_case.sql', change.path));
        continue;
      }
      if (Number(match[1]) !== highest + 1) {
        findings.push(
          finding('CHG-001', 'BLOCK', `migration number must be ${String(highest + 1).padStart(3, '0')}, the next in sequence`, change.path),
        );
        continue;
      }
      highest += 1;
      findings.push(finding('CHG-001', 'REQUIRE_APPROVAL', 'adds a database migration', change.path));
    }
    return findings;
  },
};

type Dependencies = Record<string, string>;

function dependenciesOf(packageJson: string | undefined): Dependencies {
  if (packageJson === undefined) return {};
  try {
    const parsed = JSON.parse(packageJson) as { dependencies?: Dependencies; devDependencies?: Dependencies };
    return { ...parsed.devDependencies, ...parsed.dependencies };
  } catch {
    return {};
  }
}

/** Names of dependencies added, removed or re-versioned by the change. */
export function dependencyChanges(before: string | undefined, after: string | undefined): string[] {
  const old = dependenciesOf(before);
  const next = dependenciesOf(after);
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].filter((name) => old[name] !== next[name]).sort();
}

/** CHG-002: third-party code enters the build only with a person's sign-off. */
export const dependencyChange: PolicyRule = {
  id: 'CHG-002',
  category: 'CHANGE_CONTROL',
  description: 'Adding, removing or re-versioning a dependency needs approval.',
  evaluate: ({ changes, readBaseline }) => {
    const change = changes.find((candidate) => candidate.path === 'package.json');
    if (!change) return [];
    if (change.action === 'delete') return [finding('CHG-002', 'BLOCK', 'package.json may not be deleted', change.path)];
    try {
      JSON.parse(change.content ?? '');
    } catch {
      return [finding('CHG-002', 'BLOCK', 'package.json is not valid JSON', change.path)];
    }
    return dependencyChanges(readBaseline('package.json'), change.content).map((name) =>
      finding('CHG-002', 'REQUIRE_APPROVAL', `changes dependency "${name}"`, change.path),
    );
  },
};

/** The operations an OpenAPI document declares, as "METHOD /path". Reads only the structure it needs. */
export function apiOperations(openapi: string | undefined): Set<string> {
  const operations = new Set<string>();
  if (openapi === undefined) return operations;
  let inPaths = false;
  let currentPath: string | undefined;
  for (const line of openapi.split('\n')) {
    if (/^\S/.test(line)) inPaths = line.startsWith('paths:');
    if (!inPaths) continue;
    const path = /^ {2}(\/[^:]*):\s*$/.exec(line);
    if (path) {
      currentPath = path[1];
      continue;
    }
    const method = /^ {4}(get|put|post|delete|patch|head|options):\s*$/.exec(line);
    if (method && currentPath) operations.add(`${method[1]!.toUpperCase()} ${currentPath}`);
  }
  return operations;
}

/** CHG-003: taking something away from consumers (a file, an API operation) needs approval. */
export const removals: PolicyRule = {
  id: 'CHG-003',
  category: 'CHANGE_CONTROL',
  description: 'Deleting files or removing API operations needs approval.',
  evaluate: ({ changes, readBaseline }) => {
    const findings = changes
      .filter((change) => change.action === 'delete')
      .map((change) => finding('CHG-003', 'REQUIRE_APPROVAL', 'deletes a file', change.path));

    const contract = changes.find((change) => change.path === 'openapi.yaml');
    if (contract) {
      const after = apiOperations(contract.content);
      for (const operation of apiOperations(readBaseline('openapi.yaml'))) {
        if (!after.has(operation)) {
          findings.push(finding('CHG-003', 'REQUIRE_APPROVAL', `removes API operation ${operation} (breaking change)`, contract.path));
        }
      }
    }
    return findings;
  },
};

/** CHG-004: a change too large to review properly is a risk in itself. */
export function blastRadius(limits: PolicyLimits): PolicyRule {
  return {
    id: 'CHG-004',
    category: 'CHANGE_CONTROL',
    description: `A change touching more than ${limits.maxChangedFiles} files or ${limits.maxChangedLines} lines needs approval.`,
    evaluate: ({ changes }) => {
      const lines = changes.reduce((total, change) => total + (change.content?.split('\n').length ?? 0), 0);
      const findings: Finding[] = [];
      if (changes.length > limits.maxChangedFiles) {
        findings.push(finding('CHG-004', 'REQUIRE_APPROVAL', `touches ${changes.length} files (limit ${limits.maxChangedFiles})`));
      }
      if (lines > limits.maxChangedLines) {
        findings.push(finding('CHG-004', 'REQUIRE_APPROVAL', `writes ${lines} lines (limit ${limits.maxChangedLines})`));
      }
      return findings;
    },
  };
}

/**
 * CHG-005: the implementation stays inside the design a person approved.
 * The design declares a change envelope. If the code then adds a migration, a dependency or a
 * breaking API change the envelope did not declare, the approval did not cover it.
 */
export const designConformance: PolicyRule = {
  id: 'CHG-005',
  category: 'CHANGE_CONTROL',
  description: 'The change does nothing high-impact that the approved design did not declare.',
  evaluate: ({ changes, envelope, baselineFiles, readBaseline }) => {
    if (!envelope) return [];
    const findings: Finding[] = [];

    const newMigrations = changes.filter((change) => change.path.startsWith('migrations/') && !baselineFiles.has(change.path));
    if (newMigrations.length > 0 && !envelope.schemaChange) {
      findings.push(finding('CHG-005', 'BLOCK', 'adds a migration, but the approved design declares no schema change', newMigrations[0]!.path));
    }

    const manifest = changes.find((change) => change.path === 'package.json');
    if (manifest && manifest.action !== 'delete') {
      const undeclared = dependencyChanges(readBaseline('package.json'), manifest.content).filter(
        (name) => !envelope.newDependencies.includes(name),
      );
      for (const name of undeclared) {
        findings.push(finding('CHG-005', 'BLOCK', `changes dependency "${name}", which the approved design does not declare`, manifest.path));
      }
    }

    const contract = changes.find((change) => change.path === 'openapi.yaml');
    if (contract) {
      const before = apiOperations(readBaseline('openapi.yaml'));
      const after = apiOperations(contract.content);
      const removed = [...before].filter((operation) => !after.has(operation));
      const added = [...after].filter((operation) => !before.has(operation));
      if (removed.length > 0 && envelope.apiChange !== 'breaking') {
        findings.push(finding('CHG-005', 'BLOCK', `removes ${removed.join(', ')}, but the approved design declares no breaking API change`, contract.path));
      }
      if (added.length > 0 && envelope.apiChange === 'none') {
        findings.push(finding('CHG-005', 'BLOCK', `adds ${added.join(', ')}, but the approved design declares no API change`, contract.path));
      }
    }
    return findings;
  },
};

const DISABLED_TEST = /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe)\s*\(/;

/**
 * QA-001: tests may be added and changed, never removed or switched off.
 * The cheapest way for an agent to make a failing build pass is to delete the test that fails.
 */
export const testIntegrity: PolicyRule = {
  id: 'QA-001',
  category: 'QUALITY',
  description: 'Test files are not deleted and tests are not skipped, focused or left as todo.',
  evaluate: ({ changes }) =>
    changes
      .filter((change) => change.path.startsWith('test/'))
      .flatMap((change): Finding[] => {
        if (change.action === 'delete') {
          return [{ ruleId: 'QA-001', category: 'QUALITY', severity: 'BLOCK', message: 'deletes a test file', path: change.path }];
        }
        const line = (change.content ?? '').split('\n').findIndex((text) => DISABLED_TEST.test(text));
        return line >= 0
          ? [{ ruleId: 'QA-001', category: 'QUALITY', severity: 'BLOCK', message: `disables or focuses a test (line ${line + 1})`, path: change.path }]
          : [];
      }),
};
