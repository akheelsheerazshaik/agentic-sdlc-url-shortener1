import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fsx.ts';
import { hashOf } from '../util/hash.ts';
import type { ArtifactStatus, ArtifactVersion, RunState } from './types.ts';

export interface PublishOptions {
  status: ArtifactStatus;
  producedBy: ArtifactVersion['producedBy'];
  derivedFrom: Record<string, string>;
  at: string;
}

/**
 * Versioned, content-addressed store for everything stages hand to each other.
 *
 * Stages never pass data directly. They publish artifacts here and read the latest accepted
 * version, which is what makes three things possible: a run can stop and resume in another
 * process, a stage can tell whether its inputs changed by comparing hashes, and every output
 * records which input versions it was derived from.
 */
export class ArtifactStore {
  private readonly runDir: string;
  private readonly state: RunState;

  constructor(runDir: string, state: RunState) {
    this.runDir = runDir;
    this.state = state;
  }

  /**
   * Stores a new version. Publishing content identical to the current accepted version returns
   * that version unchanged, so re-running a stage that produces the same output does not look
   * like a change to the stages downstream.
   */
  publish(name: string, content: unknown, options: PublishOptions): { version: ArtifactVersion; created: boolean } {
    const hash = hashOf(content);
    const versions = (this.state.artifacts[name] ??= []);

    const current = this.latest(name);
    if (options.status === 'accepted' && current && current.hash === hash) {
      if (JSON.stringify(current.derivedFrom) !== JSON.stringify(options.derivedFrom)) {
        (current.reaffirmations ??= []).push({
          derivedFrom: options.derivedFrom,
          generation: options.producedBy.generation,
          at: options.at,
        });
      }
      return { version: current, created: false };
    }

    const number = versions.length + 1;
    const file = join('artifacts', name, `v${number}.json`);
    writeJsonAtomic(join(this.runDir, file), content);
    const version: ArtifactVersion = {
      name,
      version: number,
      hash,
      status: options.status,
      producedBy: options.producedBy,
      derivedFrom: options.derivedFrom,
      createdAt: options.at,
      file,
    };
    versions.push(version);
    return { version, created: true };
  }

  /** The newest version with the given status; accepted by default, which is what stages consume. */
  latest(name: string, status: ArtifactStatus = 'accepted'): ArtifactVersion | undefined {
    const versions = this.state.artifacts[name] ?? [];
    for (let index = versions.length - 1; index >= 0; index--) {
      if (versions[index]!.status === status) return versions[index];
    }
    return undefined;
  }

  read<T = unknown>(version: ArtifactVersion): T {
    return readJson<T>(join(this.runDir, version.file));
  }

  /** Content of the latest accepted version, or undefined when there is none. */
  content<T = unknown>(name: string): T | undefined {
    const version = this.latest(name);
    return version ? this.read<T>(version) : undefined;
  }

  setStatus(name: string, fromStatus: ArtifactStatus, toStatus: ArtifactStatus, stageId: string): ArtifactVersion[] {
    const changed: ArtifactVersion[] = [];
    for (const version of this.state.artifacts[name] ?? []) {
      if (version.status === fromStatus && version.producedBy.stageId === stageId) {
        version.status = toStatus;
        changed.push(version);
      }
    }
    return changed;
  }

  /**
   * Walks `derivedFrom` edges back to the run's original inputs.
   * Returns one line per artifact version, indented by depth: the decision lineage of an output.
   */
  lineage(name: string): string[] {
    const lines: string[] = [];
    const byHash = new Map<string, ArtifactVersion>();
    for (const versions of Object.values(this.state.artifacts)) {
      for (const version of versions) byHash.set(`${version.name}:${version.hash}`, version);
    }
    const visit = (version: ArtifactVersion, depth: number, seen: Set<string>): void => {
      const key = `${version.name}:${version.hash}`;
      // The most recent derivation: the inputs this content was last produced from.
      const latest = version.reaffirmations?.at(-1);
      const generation = latest?.generation ?? version.producedBy.generation;
      lines.push(
        `${'  '.repeat(depth)}${version.name} v${version.version} [${version.hash.slice(0, 12)}] by ${version.producedBy.actor} (${version.producedBy.stageId}, generation ${generation}${latest ? ', unchanged from an earlier generation' : ''})${seen.has(key) ? ' …' : ''}`,
      );
      if (seen.has(key)) return;
      seen.add(key);
      for (const [parentName, parentHash] of Object.entries(latest?.derivedFrom ?? version.derivedFrom).sort()) {
        const parent = byHash.get(`${parentName}:${parentHash}`);
        if (parent) visit(parent, depth + 1, seen);
      }
    };
    const start = this.latest(name) ?? this.latest(name, 'proposed');
    if (start) visit(start, 0, new Set());
    return lines;
  }
}
