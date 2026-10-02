import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { listFiles } from '../util/fsx.ts';

export interface ModuleInfo {
  /** Other modules in the tree that this one imports. */
  imports: string[];
  exports: string[];
  lines: number;
}

export interface CodeIndex {
  files: string[];
  modules: Record<string, ModuleInfo>;
  routes: { method: string; path: string; file: string }[];
  migrations: string[];
  tables: string[];
  tests: string[];
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
const EXPORT = /export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_]\w*)/g;
const ROUTE = /\bapp\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
const TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi;

/**
 * A structural index of the existing codebase, built by reading the files rather than by asking a
 * model. It gives the agents facts to reason from (what exists, what imports what, which routes
 * and tables there are) and gives the gates something to check the agents' claims against.
 */
export function buildCodeIndex(root: string): CodeIndex {
  const files = listFiles(root);
  const index: CodeIndex = { files, modules: {}, routes: [], migrations: [], tables: [], tests: [] };

  for (const file of files) {
    if (/^migrations\/.+\.sql$/.test(file)) {
      index.migrations.push(file);
      const sql = readFileSync(join(root, file), 'utf8');
      for (const match of sql.matchAll(TABLE)) index.tables.push(match[1]!);
      continue;
    }
    if (!file.endsWith('.ts')) continue;
    if (file.startsWith('test/')) index.tests.push(file);

    const source = readFileSync(join(root, file), 'utf8');
    const imports = [...source.matchAll(IMPORT)].map((match) => posix.normalize(posix.join(posix.dirname(file), match[1]!)));
    index.modules[file] = {
      imports: [...new Set(imports)].filter((path) => files.includes(path)).sort(),
      exports: [...new Set([...source.matchAll(EXPORT)].map((match) => match[1]!))].sort(),
      lines: source.split('\n').length,
    };
    for (const match of source.matchAll(ROUTE)) {
      index.routes.push({ method: match[1]!.toUpperCase(), path: match[2]!, file });
    }
  }
  index.tables = [...new Set(index.tables)].sort();
  return index;
}

/**
 * Every module that imports one of `paths`, directly or through other modules: the code whose
 * behaviour could change when those modules change. Tests are included, which tells the reviewer
 * which existing tests guard the change.
 */
export function dependentsOf(index: CodeIndex, paths: readonly string[]): string[] {
  const importers = new Map<string, string[]>();
  for (const [file, module] of Object.entries(index.modules)) {
    for (const imported of module.imports) {
      importers.set(imported, [...(importers.get(imported) ?? []), file]);
    }
  }
  const seen = new Set<string>();
  const queue = [...paths];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const importer of importers.get(current) ?? []) {
      if (!seen.has(importer) && !paths.includes(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return [...seen].sort();
}
