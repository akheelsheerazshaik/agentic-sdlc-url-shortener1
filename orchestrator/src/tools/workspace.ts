import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { FileChange } from '../agents/schemas.ts';
import { isContainedPath } from '../governance/rules/security.ts';
import { listFiles, mirrorTree, snapshotTree, type TreeSnapshot } from '../util/fsx.ts';

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface WorkspaceDiff {
  files: FileDiff[];
  /** Unified diff of the whole change, the artifact a human reviews. */
  patch: string;
}

/**
 * The sandbox a run works in.
 *
 * `baseline/` is a pristine copy of the target as it was when the run started. `workspace/` is
 * where changes are applied and verified. The target itself is not touched until promotion, so a
 * run that fails or is rejected leaves nothing behind.
 */
export class Workspace {
  readonly root: string;
  readonly baselineDir: string;

  constructor(runDir: string) {
    this.root = join(runDir, 'workspace');
    this.baselineDir = join(runDir, 'baseline');
  }

  /** Copies the target into the run as both baseline and starting workspace. */
  initialize(targetDir: string): TreeSnapshot {
    mkdirSync(this.baselineDir, { recursive: true });
    if (existsSync(targetDir)) mirrorTree(targetDir, this.baselineDir);
    mirrorTree(this.baselineDir, this.root);
    return snapshotTree(this.baselineDir);
  }

  baselineFiles(): Set<string> {
    return new Set(listFiles(this.baselineDir));
  }

  readBaseline = (path: string): string | undefined => {
    const file = join(this.baselineDir, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };

  /** Puts the workspace back to the baseline. Applying changes always starts from here, which makes it repeatable. */
  reset(): void {
    mirrorTree(this.baselineDir, this.root);
  }

  apply(changes: FileChange[]): void {
    const rootPrefix = resolve(this.root) + sep;
    for (const change of changes) {
      // Policy has already checked these paths. This is the last line of defence at the point of writing.
      const file = resolve(this.root, change.path);
      if (!isContainedPath(change.path) || !file.startsWith(rootPrefix)) {
        throw new Error(`Refusing to write outside the workspace: ${change.path}`);
      }
      if (change.action === 'delete') {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, change.content ?? '');
      }
    }
  }

  snapshot(): TreeSnapshot {
    return snapshotTree(this.root);
  }

  diff(): WorkspaceDiff {
    const before = snapshotTree(this.baselineDir).files;
    const after = snapshotTree(this.root).files;
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

    const files: FileDiff[] = [];
    const patches: string[] = [];
    for (const path of paths) {
      if (before[path] === after[path]) continue;
      const oldText = before[path] ? readFileSync(join(this.baselineDir, path), 'utf8') : '';
      const newText = after[path] ? readFileSync(join(this.root, path), 'utf8') : '';
      const patch = createTwoFilesPatch(
        before[path] ? `a/${path}` : '/dev/null',
        after[path] ? `b/${path}` : '/dev/null',
        oldText,
        newText,
      );
      const body = patch.split('\n').slice(4);
      files.push({
        path,
        status: !before[path] ? 'added' : !after[path] ? 'deleted' : 'modified',
        additions: body.filter((line) => line.startsWith('+')).length,
        deletions: body.filter((line) => line.startsWith('-')).length,
      });
      patches.push(patch);
    }
    return { files, patch: patches.join('\n') };
  }
}
