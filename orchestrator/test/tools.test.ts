import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFault, withFault } from '../src/engine/faults.ts';
import { buildCodeIndex, dependentsOf } from '../src/tools/codeIndex.ts';
import { CommandRunner, sanitizedEnvironment } from '../src/tools/commandRunner.ts';
import { Workspace } from '../src/tools/workspace.ts';
import { listFiles, mirrorTree, snapshotTree } from '../src/util/fsx.ts';
import { canonicalJson, hashOf } from '../src/util/hash.ts';
import { agent } from './harness.ts';
import { context, tempDir, writeTree } from './fixtures.ts';

const signal = new AbortController().signal;

describe('hashing', () => {
  it('gives the same hash for the same value whatever the key order', () => {
    expect(hashOf({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(hashOf({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  it('gives different hashes for different values, including array order', () => {
    expect(hashOf({ a: [1, 2] })).not.toBe(hashOf({ a: [2, 1] }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: '1' }));
  });
});

describe('file tree helpers', () => {
  it('lists files in a stable order and skips dependency and build directories', () => {
    const root = tempDir();
    writeTree(root, { 'src/b.ts': '', 'src/a.ts': '', 'node_modules/x/index.js': '', '.git/HEAD': '', 'data/app.db': '', 'README.md': '' });
    expect(listFiles(root)).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
  });

  it('changes the tree hash when a file is edited, added or removed', () => {
    const root = tempDir();
    writeTree(root, { 'a.txt': 'one' });
    const original = snapshotTree(root).treeHash;
    writeTree(root, { 'a.txt': 'two' });
    const edited = snapshotTree(root).treeHash;
    writeTree(root, { 'a.txt': 'one', 'b.txt': '' });
    const added = snapshotTree(root).treeHash;
    expect(new Set([original, edited, added]).size).toBe(3);
  });

  it('mirrors a tree exactly, removing what is not in the source', () => {
    const source = tempDir();
    const destination = tempDir();
    writeTree(source, { 'src/a.ts': 'new', 'README.md': 'r' });
    writeTree(destination, { 'src/a.ts': 'old', 'src/stale.ts': 'x', 'node_modules/kept/index.js': 'k' });
    mirrorTree(source, destination);
    expect(listFiles(destination)).toEqual(['README.md', 'src/a.ts']);
    expect(readFileSync(join(destination, 'src/a.ts'), 'utf8')).toBe('new');
    expect(existsSync(join(destination, 'node_modules/kept/index.js'))).toBe(true);
  });
});

describe('Workspace', () => {
  function setup(files: Record<string, string>) {
    const root = tempDir();
    writeTree(join(root, 'target'), files);
    const workspace = new Workspace(join(root, 'run'));
    workspace.initialize(join(root, 'target'));
    return { workspace, targetDir: join(root, 'target') };
  }

  it('starts as a copy of the target and never writes to the target', () => {
    const { workspace, targetDir } = setup({ 'src/a.ts': 'one\n' });
    workspace.apply([{ path: 'src/a.ts', action: 'modify', content: 'two\n', taskIds: ['T-1'] }]);
    expect(readFileSync(join(workspace.root, 'src/a.ts'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(targetDir, 'src/a.ts'), 'utf8')).toBe('one\n');
    expect(workspace.readBaseline('src/a.ts')).toBe('one\n');
  });

  it('initializes from a target that does not exist yet', () => {
    const root = tempDir();
    const workspace = new Workspace(join(root, 'run'));
    const baseline = workspace.initialize(join(root, 'not-created-yet'));
    expect(baseline.files).toEqual({});
    expect(workspace.baselineFiles().size).toBe(0);
  });

  it('creates, modifies and deletes files, and reports the diff', () => {
    const { workspace } = setup({ 'src/keep.ts': 'same\n', 'src/edit.ts': 'a\nb\n', 'src/remove.ts': 'gone\n' });
    workspace.apply([
      { path: 'src/edit.ts', action: 'modify', content: 'a\nB\nc\n', taskIds: ['T-1'] },
      { path: 'src/remove.ts', action: 'delete', taskIds: ['T-1'] },
      { path: 'src/new/deep.ts', action: 'create', content: 'x\n', taskIds: ['T-1'] },
    ]);
    const diff = workspace.diff();
    expect(diff.files).toEqual([
      { path: 'src/edit.ts', status: 'modified', additions: 2, deletions: 1 },
      { path: 'src/new/deep.ts', status: 'added', additions: 1, deletions: 0 },
      { path: 'src/remove.ts', status: 'deleted', additions: 0, deletions: 1 },
    ]);
    expect(diff.patch).toContain('--- a/src/edit.ts');
    expect(diff.patch).toContain('+++ b/src/new/deep.ts');
    expect(diff.patch).toContain('-gone');
  });

  it('returns to the baseline on reset, so applying is repeatable', () => {
    const { workspace } = setup({ 'src/a.ts': 'one\n' });
    const baseline = workspace.snapshot().treeHash;
    const changes = [{ path: 'src/b.ts', action: 'create' as const, content: 'new\n', taskIds: ['T-1'] }];
    workspace.apply(changes);
    const first = workspace.snapshot().treeHash;
    workspace.reset();
    expect(workspace.snapshot().treeHash).toBe(baseline);
    workspace.apply(changes);
    expect(workspace.snapshot().treeHash).toBe(first);
  });

  it.each(['../outside.ts', '/tmp/absolute.ts', 'src/../../outside.ts'])('refuses to write %s even if policy was bypassed', (path) => {
    const { workspace } = setup({});
    expect(() => workspace.apply([{ path, action: 'create', content: 'x', taskIds: ['T-1'] }])).toThrowError(/Refusing to write outside the workspace/);
  });
});

describe('CommandRunner', () => {
  const node = process.execPath;

  it('runs only commands on the allowlist', async () => {
    const runner = new CommandRunner({ hello: { argv: [node, '-e', 'console.log("hi")'], timeoutMs: 5000 } });
    const result = await runner.run('hello', tempDir(), signal);
    expect(result).toMatchObject({ id: 'hello', exitCode: 0, timedOut: false });
    expect(result.output.trim()).toBe('hi');
    await expect(runner.run('rm', tempDir(), signal)).rejects.toThrowError('Command "rm" is not on the allowlist.');
  });

  it('reports a failing command with its output rather than throwing', async () => {
    const runner = new CommandRunner({ fail: { argv: [node, '-e', 'console.error("boom"); process.exit(3)'], timeoutMs: 5000 } });
    const result = await runner.run('fail', tempDir(), signal);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('boom');
  });

  it('runs in the given directory and fills in placeholders it was given', async () => {
    const directory = tempDir();
    const runner = new CommandRunner({ write: { argv: [node, '-e', 'require("fs").writeFileSync(process.argv[1], process.cwd())', '{file}'], timeoutMs: 5000 } });
    await runner.run('write', directory, signal, { file: join(directory, 'out.txt') });
    expect(readFileSync(join(directory, 'out.txt'), 'utf8')).toContain(directory.split('/').at(-1));
  });

  it('withholds secrets from the child process', async () => {
    const environment = sanitizedEnvironment({ PATH: process.env.PATH, HOME: '/home/x', ANTHROPIC_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'aws', npm_config_cache: '/cache', DATABASE_URL: 'postgres://u:p@h/db' });
    expect(Object.keys(environment).sort()).toEqual(['CI', 'HOME', 'NO_COLOR', 'PATH', 'npm_config_cache']);

    const runner = new CommandRunner({ env: { argv: [node, '-e', 'console.log(JSON.stringify(process.env))'], timeoutMs: 5000 } }, environment);
    const seen = JSON.parse((await runner.run('env', tempDir(), signal)).output);
    expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.CI).toBe('true');
  });

  it('kills a command that exceeds its timeout', async () => {
    const runner = new CommandRunner({ hang: { argv: [node, '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 100 } });
    const result = await runner.run('hang', tempDir(), signal);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('kills a running command when the run is aborted', async () => {
    const abort = new AbortController();
    const runner = new CommandRunner({ hang: { argv: [node, '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 60_000 } });
    const pending = runner.run('hang', tempDir(), abort.signal);
    setTimeout(() => abort.abort(), 50);
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('reports a program that cannot be started', async () => {
    const runner = new CommandRunner({ missing: { argv: ['definitely-not-a-real-program-xyz'], timeoutMs: 5000 } });
    await expect(runner.run('missing', tempDir(), signal)).rejects.toThrowError(/Could not start/);
  });
});

describe('code index', () => {
  const root = tempDir();
  writeTree(root, {
    'src/app.ts': "import { registerRoutes } from './http/routes.ts';\nexport function buildApp() {}\n",
    'src/http/routes.ts': "import type { LinkService } from '../links/linkService.ts';\nexport function registerRoutes(app) {\n  app.get('/:code', handler);\n  app.post('/api/v1/links', handler);\n}\n",
    'src/links/linkService.ts': "import { LinkRepository } from './linkRepository.ts';\nimport { z } from 'zod';\nexport class LinkService {}\nexport const MAX = 1;\n",
    'src/links/linkRepository.ts': 'export class LinkRepository {}\n',
    'src/unrelated.ts': 'export const nothing = 0;\n',
    'test/links.test.ts': "import { LinkService } from '../src/links/linkService.ts';\n",
    'migrations/001_init.sql': 'CREATE TABLE links (code TEXT);\nCREATE TABLE IF NOT EXISTS click_events (id INTEGER);\n',
    'README.md': '# readme\n',
  });
  const index = buildCodeIndex(root);

  it('records imports between modules of the tree, exports, routes, tables and tests', () => {
    expect(index.modules['src/links/linkService.ts']).toEqual({ imports: ['src/links/linkRepository.ts'], exports: ['LinkService', 'MAX'], lines: 5 });
    expect(index.routes).toEqual([
      { method: 'GET', path: '/:code', file: 'src/http/routes.ts' },
      { method: 'POST', path: '/api/v1/links', file: 'src/http/routes.ts' },
    ]);
    expect(index.tables).toEqual(['click_events', 'links']);
    expect(index.migrations).toEqual(['migrations/001_init.sql']);
    expect(index.tests).toEqual(['test/links.test.ts']);
    expect(index.files).toContain('README.md');
  });

  it('finds everything that depends on a module, directly or through other modules', () => {
    expect(dependentsOf(index, ['src/links/linkRepository.ts'])).toEqual([
      'src/app.ts',
      'src/http/routes.ts',
      'src/links/linkService.ts',
      'test/links.test.ts',
    ]);
    expect(dependentsOf(index, ['src/unrelated.ts'])).toEqual([]);
  });
});

describe('fault injection', () => {
  it('parses fault specifications', () => {
    expect(parseFault('implementation=error:2')).toEqual({ stageId: 'implementation', when: 'before', times: 2 });
    expect(parseFault('promote=error-after:always')).toEqual({ stageId: 'promote', when: 'after', times: Infinity });
    expect(() => parseFault('promote=explode')).toThrowError(/Invalid fault/);
  });

  it('fails the first N invocations without running the agent, then lets it through', async () => {
    let ran = 0;
    const faulty = withFault(agent('agent:a', () => (ran++, { outputs: {} })), parseFault('a=error:2'));
    await expect(faulty.run(context({}))).rejects.toThrowError(/injected fault/);
    await expect(faulty.run(context({}))).rejects.toThrowError(/injected fault/);
    await expect(faulty.run(context({}))).resolves.toEqual({ outputs: {} });
    expect(ran).toBe(1);
  });

  it('can fail after the agent has acted, which is what exercises compensation', async () => {
    const file = join(tempDir(), 'side-effect.txt');
    const faulty = withFault(agent('agent:a', () => (writeFileSync(file, 'done'), { outputs: {} })), parseFault('a=error-after:1'));
    await expect(faulty.run(context({}))).rejects.toThrowError(/after the action was performed/);
    expect(existsSync(file)).toBe(true);
  });

  it('leaves an agent without a fault untouched', () => {
    const original = agent('agent:a', () => ({ outputs: {} }));
    expect(withFault(original, undefined)).toBe(original);
  });
});
