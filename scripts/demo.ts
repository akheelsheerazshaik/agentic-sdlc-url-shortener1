#!/usr/bin/env node
/**
 * Runs the scenarios end to end through the command-line interface, the way a person would:
 * start a run, read what it is waiting for, record a decision, resume.
 *
 *   node scripts/demo.ts                 all scenarios, then the failure demonstrations
 *   node scripts/demo.ts greenfield      one part: greenfield | brownfield | ambiguous | failures
 *
 * Every decision below is made by this script on the "cli" channel under the names demo-requester
 * and demo-reviewer. They stand in for the people who would make those decisions.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'orchestrator', 'src', 'cli.ts');
const OUT = join(REPO, 'demo-output');
const RUNS = join(OUT, 'runs');
const TARGET = join(OUT, 'url-shortener');
const SERVICE_V1 = join(OUT, 'url-shortener-v1');

const DONE = 0;
const WAITING = 3;
const STOPPED = 4;

function heading(text: string): void {
  console.log(`\n${'='.repeat(100)}\n${text}\n${'='.repeat(100)}`);
}

function note(text: string): void {
  console.log(`\n# ${text}`);
}

/** Runs one CLI command, echoing it first, and checks that it ended the way the demo expects. */
function sdlc(expected: number, ...args: string[]): void {
  console.log(`\n$ sdlc ${args.map((arg) => (/[\s"=]/.test(arg) ? `'${arg}'` : arg.startsWith(REPO) ? relative(REPO, arg) : arg)).join(' ')}`);
  const result = spawnSync(process.execPath, [CLI, ...args, '--runs', RUNS], { stdio: 'inherit' });
  if (result.status !== expected) {
    console.error(`\nDemo stopped: expected exit code ${expected}, got ${result.status}.`);
    process.exit(1);
  }
}

const scenario = (name: string): string => join(REPO, 'scenarios', name);
const approve = (run: string, stage: string, comment: string): void => sdlc(DONE, 'approve', run, stage, '--by', 'demo-reviewer', '--comment', comment);

function greenfield(run = 'greenfield', target = TARGET): void {
  heading('SCENARIO 1: GREENFIELD. Build the URL shortener from a well-defined requirement, starting from nothing.');
  sdlc(WAITING, 'run', '--scenario', scenario('01-greenfield'), '--target', target, '--run-id', run);
  note('The design adds a schema, an API and dependencies, so it needs a person. The run has exited and is waiting.');
  approve(run, 'architecture', 'Design, schema and dependency list accepted.');
  sdlc(WAITING, 'resume', run);
  note('Built and verified in the sandbox. Nothing has been written to the target yet. A release always needs sign-off.');
  approve(run, 'release-readiness', 'First release approved.');
  sdlc(DONE, 'resume', run);
}

function brownfield(): void {
  heading('SCENARIO 2: BROWNFIELD. Add link expiry and fix a defect in the existing service.');
  sdlc(WAITING, 'run', '--scenario', scenario('02-brownfield'), '--target', TARGET, '--run-id', 'brownfield');
  approve('brownfield', 'architecture', 'Additive migration and API change accepted.');
  note('Watch the build: the first implementation misses a validation rule, the independently written tests fail,');
  note('and the engine sends the work back with the failure as feedback.');
  sdlc(WAITING, 'resume', 'brownfield');
  approve('brownfield', 'release-readiness', 'Release approved. Rollback plan reviewed.');
  sdlc(DONE, 'resume', 'brownfield');
  sdlc(DONE, 'lineage', 'brownfield', 'test-report');
}

function ambiguous(): void {
  heading('SCENARIO 3: AMBIGUOUS. "Better insight into who is clicking" and "safer links".');
  sdlc(WAITING, 'run', '--scenario', scenario('03-ambiguous'), '--target', TARGET, '--run-id', 'ambiguous');
  note('Three questions change what would be built and what personal data would be held, so the run will not guess.');
  sdlc(
    DONE, 'clarify', 'ambiguous', '--by', 'demo-requester',
    '--answer', 'Q-1=Aggregate only. We must not store anything that identifies a visitor: no IP addresses, no raw user agents, no visitor IDs.',
    '--answer', 'Q-3=Unsafe destinations. The concern is links that send people to malicious sites or to internal addresses. API abuse is a separate project.',
    '--answer', 'Q-5=Existing links too. If a destination is denied later, the old link must stop redirecting.',
  );
  sdlc(WAITING, 'resume', 'ambiguous');
  note('At design review the reviewer asks for more. The change request goes back to the requirements stage,');
  note('and every stage whose inputs changed is re-run. The impact analysis is re-derived and comes out identical.');
  sdlc(DONE, 'request-changes', 'ambiguous', 'architecture', '--by', 'demo-reviewer', '--comment', 'Bots must not inflate campaign numbers: report bot and non-bot clicks separately in the stats.');
  sdlc(WAITING, 'resume', 'ambiguous');
  approve('ambiguous', 'architecture', 'Approved with the bot split. Privacy position confirmed: device class only.');
  sdlc(WAITING, 'resume', 'ambiguous');
  approve('ambiguous', 'release-readiness', 'Release approved.');
  sdlc(DONE, 'resume', 'ambiguous');
}

function failures(): void {
  heading('FAILURE DEMONSTRATIONS. Fallback, rework budget, rollback, safe stop, authorized retry.');
  if (!existsSync(SERVICE_V1)) {
    note('These need the first version of the service as a starting point, so it is built first.');
    greenfield('failures-setup', SERVICE_V1);
  }
  const copyOfV1 = (name: string): string => {
    const target = join(OUT, 'failures', name);
    rmSync(target, { recursive: true, force: true });
    cpSync(SERVICE_V1, target, { recursive: true });
    return target;
  };

  note('A. The planning agent fails on every call. After its retries the engine switches to the fallback agent.');
  sdlc(WAITING, 'run', '--scenario', scenario('01-greenfield'), '--target', join(OUT, 'failures', 'fallback'), '--run-id', 'failure-fallback', '--fault', 'planning=error:always');

  note('B. No rework allowed. The build fails, there is no budget to send it back, so the run rolls back and stops.');
  sdlc(WAITING, 'run', '--scenario', scenario('02-brownfield'), '--target', copyOfV1('no-rework'), '--run-id', 'failure-no-rework', '--max-reworks', '0');
  approve('failure-no-rework', 'architecture', 'Design accepted.');
  sdlc(STOPPED, 'resume', 'failure-no-rework');

  note('C. Promotion fails after it has copied files into the target. The target is restored from its backup.');
  const target = copyOfV1('promote-fails');
  sdlc(WAITING, 'run', '--scenario', scenario('02-brownfield'), '--target', target, '--run-id', 'failure-promote', '--fault', 'promote=error-after:1');
  approve('failure-promote', 'architecture', 'Design accepted.');
  sdlc(WAITING, 'resume', 'failure-promote');
  approve('failure-promote', 'release-readiness', 'Release approved.');
  sdlc(STOPPED, 'resume', 'failure-promote');
  note('A stopped run stays stopped. A plain resume is refused (exit code 2):');
  sdlc(2, 'resume', 'failure-promote');
  note('A person authorizes the retry. The change is byte-for-byte the one already verified and approved, so only the promotion runs.');
  sdlc(DONE, 'resume', 'failure-promote', '--retry', '--by', 'demo-reviewer');
}

function summary(): void {
  heading('ACROSS ALL RUNS');
  sdlc(DONE, 'metrics');
  for (const run of ['greenfield', 'brownfield', 'ambiguous']) {
    if (existsSync(join(RUNS, run))) sdlc(DONE, 'audit', run);
  }
  console.log(`\nReview packets: ${relative(REPO, RUNS)}/<run>/review/README.md`);
  console.log(`Delivered service: ${relative(REPO, TARGET)}/`);
}

const part = process.argv[2] ?? 'all';
const parts: Record<string, () => void> = {
  greenfield: () => greenfield(),
  brownfield,
  ambiguous,
  failures,
  all: () => {
    greenfield();
    cpSync(TARGET, SERVICE_V1, { recursive: true });
    brownfield();
    ambiguous();
    failures();
  },
};
if (!(part in parts)) {
  console.error(`Unknown part "${part}". Use one of: ${Object.keys(parts).join(', ')}.`);
  process.exit(2);
}
if (part === 'all' || part === 'greenfield') rmSync(OUT, { recursive: true, force: true });
if (part === 'failures') {
  for (const run of ['failures-setup', 'failure-fallback', 'failure-no-rework', 'failure-promote']) rmSync(join(RUNS, run), { recursive: true, force: true });
  rmSync(SERVICE_V1, { recursive: true, force: true });
  rmSync(join(OUT, 'failures'), { recursive: true, force: true });
}
parts[part]!();
summary();
