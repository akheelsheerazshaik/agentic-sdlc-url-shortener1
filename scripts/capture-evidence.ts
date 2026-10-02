#!/usr/bin/env node
/**
 * Runs the full demo and keeps what it produced as evidence/: the console transcript, each run's
 * review packet and audit log, and the metrics across runs.
 *
 *   node scripts/capture-evidence.ts
 *
 * Everything in evidence/ is the output of a real run on the machine where this was executed.
 * Run it again to replace it with your own.
 */
import { spawn } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(REPO, 'demo-output', 'runs');
const EVIDENCE = join(REPO, 'evidence');
const README = join(EVIDENCE, 'README.md');

async function runDemo(transcript: string): Promise<number> {
  const file = createWriteStream(transcript);
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'demo.ts'), 'all'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      file.write(chunk);
    });
  }
  const code = await new Promise<number>((resolve) => child.on('close', (status) => resolve(status ?? 1)));
  await new Promise((resolve) => file.end(resolve));
  return code;
}

// Keep the hand-written README; replace everything the demo generates.
for (const entry of existsSync(EVIDENCE) ? readdirSync(EVIDENCE) : []) {
  if (join(EVIDENCE, entry) !== README) rmSync(join(EVIDENCE, entry), { recursive: true, force: true });
}
mkdirSync(EVIDENCE, { recursive: true });

const code = await runDemo(join(EVIDENCE, 'demo-console.log'));
if (code !== 0) {
  console.error('The demo failed; evidence was not captured.');
  process.exit(code);
}

for (const run of readdirSync(RUNS, { withFileTypes: true })) {
  if (!run.isDirectory() || run.name === 'failures-setup') continue;
  const destination = join(EVIDENCE, run.name);
  cpSync(join(RUNS, run.name, 'review'), destination, { recursive: true });
  cpSync(join(RUNS, run.name, 'audit.jsonl'), join(destination, 'audit.jsonl'));
}
cpSync(join(RUNS, 'metrics.json'), join(EVIDENCE, 'metrics.json'));
console.log(`\nEvidence written to evidence/ (${readdirSync(EVIDENCE).length} entries).`);
