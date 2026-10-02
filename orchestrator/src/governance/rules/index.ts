import { PolicyEngine, type PolicyLimits } from '../policy.ts';
import { blastRadius, dependencyChange, designConformance, migrationDiscipline, removals, testIntegrity } from './changeControl.ts';
import { noPersonalData, traceability } from './compliance.ts';
import { noDangerousCode, noSecrets, pathContainment } from './security.ts';

/**
 * Rules that must hold before anything is written to the workspace.
 * They need only the proposed files, so they run on each agent's own output and again on the
 * merged change.
 */
export const CONTAINMENT_RULES = ['SEC-001', 'SEC-002', 'QA-001'] as const;

export const DEFAULT_POLICY_LIMITS: PolicyLimits = { maxChangedFiles: 60, maxChangedLines: 6000 };

export function defaultPolicyEngine(limits: PolicyLimits = DEFAULT_POLICY_LIMITS): PolicyEngine {
  return new PolicyEngine([
    pathContainment,
    noSecrets,
    noDangerousCode,
    noPersonalData,
    traceability,
    migrationDiscipline,
    dependencyChange,
    removals,
    blastRadius(limits),
    designConformance,
    testIntegrity,
  ]);
}
