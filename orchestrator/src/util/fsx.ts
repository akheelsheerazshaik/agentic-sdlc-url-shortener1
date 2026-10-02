import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { sha256 } from './hash.ts';

/**
 * A path as the person running the command would type it: relative when it is under the current
 * directory. Used wherever a path is shown or logged, so output does not depend on one machine's layout.
 */
export function displayPath(path: string): string {
  const fromHere = relative(process.cwd(), path);
  return fromHere === '' ? '.' : fromHere.startsWith('..') ? path : fromHere.split(sep).join('/');
}

/** Directories that are build output or local state, never part of a source tree. */
export const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'data', 'dist', 'coverage']);

/** Writes a file by writing a temporary file and renaming it, so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** All files under `root`, as sorted POSIX-style relative paths, skipping ignored directories. */
export function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name));
      } else if (entry.isFile()) {
        found.push(relative(root, join(directory, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

export interface TreeSnapshot {
  /** Relative path to content hash. */
  files: Record<string, string>;
  /** One hash for the whole tree: changes if any file is added, removed or edited. */
  treeHash: string;
}

export function snapshotTree(root: string): TreeSnapshot {
  const files: Record<string, string> = {};
  for (const path of listFiles(root)) {
    files[path] = sha256(readFileSync(join(root, path)));
  }
  const treeHash = sha256(
    Object.entries(files)
      .map(([path, hash]) => `${path}:${hash}`)
      .join('\n'),
  );
  return { files, treeHash };
}

/** Makes `destination` an exact copy of the source tree (ignored directories in the destination are kept). */
export function mirrorTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const wanted = new Set(listFiles(source));
  for (const existing of listFiles(destination)) {
    if (!wanted.has(existing)) rmSync(join(destination, existing));
  }
  for (const path of wanted) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, path), target);
  }
}
