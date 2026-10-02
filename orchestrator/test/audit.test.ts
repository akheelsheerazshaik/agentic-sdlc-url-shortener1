import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog, ENGINE, GENESIS } from '../src/governance/audit.ts';

function newLog() {
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
  const log = new AuditLog(file, 'run-1', () => new Date('2026-01-01T00:00:00Z'));
  return { file, log };
}

const rewrite = (file: string, change: (lines: string[]) => string[]) =>
  writeFileSync(file, `${change(readFileSync(file, 'utf8').trim().split('\n')).join('\n')}\n`);

describe('AuditLog', () => {
  it('chains each event to the one before it', () => {
    const { file, log } = newLog();
    const first = log.append('RUN_STARTED', ENGINE);
    const second = log.append('STAGE_STARTED', { kind: 'agent', id: 'agent:a' }, { attempt: 1 }, 'a');
    expect(first.prevHash).toBe(GENESIS);
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBe(2);
    expect(AuditLog.verify(file)).toEqual({ valid: true, events: 2 });
  });

  it('continues the chain when the log is reopened by another process', () => {
    const { file, log } = newLog();
    const first = log.append('RUN_STARTED', ENGINE);
    const reopened = new AuditLog(file, 'run-1');
    const second = reopened.append('RUN_RESUMED', ENGINE);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(AuditLog.verify(file).valid).toBe(true);
  });

  it('detects an edited event', () => {
    const { file, log } = newLog();
    log.append('APPROVAL_RECORDED', { kind: 'human', id: 'alice' }, { decision: 'rejected' });
    log.append('RUN_SAFE_STOPPED', ENGINE);
    rewrite(file, (lines) => [lines[0]!.replace('rejected', 'approved'), lines[1]!]);
    expect(AuditLog.verify(file)).toMatchObject({ valid: false, brokenAt: 1, reason: 'event content does not match its hash' });
  });

  it('detects a removed event', () => {
    const { file, log } = newLog();
    log.append('A', ENGINE);
    log.append('B', ENGINE);
    log.append('C', ENGINE);
    rewrite(file, (lines) => [lines[0]!, lines[2]!]);
    expect(AuditLog.verify(file)).toMatchObject({ valid: false, brokenAt: 2 });
  });

  it('detects reordered events', () => {
    const { file, log } = newLog();
    log.append('A', ENGINE);
    log.append('B', ENGINE);
    rewrite(file, (lines) => [lines[1]!, lines[0]!]);
    expect(AuditLog.verify(file).valid).toBe(false);
  });

  it('detects an event forged with a recomputed hash but a wrong link', () => {
    const { file, log } = newLog();
    log.append('A', ENGINE);
    log.append('B', ENGINE);
    const forged = new AuditLog(join(mkdtempSync(join(tmpdir(), 'audit-')), 'forged.jsonl'), 'run-1').append('FORGED', ENGINE);
    rewrite(file, (lines) => [lines[0]!, JSON.stringify({ ...forged, seq: 2 })]);
    expect(AuditLog.verify(file).valid).toBe(false);
  });

  it('reports a corrupt log instead of throwing', () => {
    const { file, log } = newLog();
    log.append('A', ENGINE);
    writeFileSync(file, 'not json\n');
    expect(AuditLog.verify(file)).toMatchObject({ valid: false, reason: 'log contains a line that is not valid JSON' });
  });
});
