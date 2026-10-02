import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256 } from '../util/hash.ts';

/** Who did something. Every audit event names exactly one actor. */
export interface Actor {
  kind: 'engine' | 'agent' | 'human' | 'policy' | 'tool';
  id: string;
}

export const ENGINE: Actor = { kind: 'engine', id: 'orchestrator' };

export interface AuditEvent {
  seq: number;
  ts: string;
  runId: string;
  type: string;
  stageId?: string | undefined;
  actor: Actor;
  data: Record<string, unknown>;
  /** Hash of the previous event; the first event points at GENESIS. */
  prevHash: string;
  /** Hash of this event's content including prevHash. */
  hash: string;
}

export const GENESIS = '0'.repeat(64);

export interface AuditVerification {
  valid: boolean;
  events: number;
  /** Sequence number of the first event that fails verification. */
  brokenAt?: number;
  reason?: string;
}

function eventHash(event: Omit<AuditEvent, 'hash'>): string {
  return sha256(canonicalJson(event));
}

/**
 * Append-only, hash-chained event log: one JSON object per line.
 *
 * Each event stores the hash of the one before it, so editing, removing or reordering any past
 * event changes every hash after it and `verify` reports where the chain breaks. That makes the
 * log tamper-evident. It is not tamper-proof: someone who can rewrite the whole file can rebuild
 * the chain, which is why the latest hash should also be copied somewhere the writer cannot change.
 */
export class AuditLog {
  private readonly file: string;
  private readonly runId: string;
  private readonly now: () => Date;
  private seq: number;
  private lastHash: string;

  constructor(file: string, runId: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.runId = runId;
    this.now = now;
    mkdirSync(dirname(file), { recursive: true });
    const existing = AuditLog.read(file);
    const last = existing.at(-1);
    this.seq = last ? last.seq : 0;
    this.lastHash = last ? last.hash : GENESIS;
  }

  append(type: string, actor: Actor, data: Record<string, unknown> = {}, stageId?: string): AuditEvent {
    const body: Omit<AuditEvent, 'hash'> = {
      seq: this.seq + 1,
      ts: this.now().toISOString(),
      runId: this.runId,
      type,
      ...(stageId !== undefined ? { stageId } : {}),
      actor,
      data,
      prevHash: this.lastHash,
    };
    const event: AuditEvent = { ...body, hash: eventHash(body) };
    // Synchronous append: the event is on disk before the action it describes is acted on.
    appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.seq = event.seq;
    this.lastHash = event.hash;
    return event;
  }

  get headHash(): string {
    return this.lastHash;
  }

  static read(file: string): AuditEvent[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  static verify(file: string): AuditVerification {
    let events: AuditEvent[];
    try {
      events = AuditLog.read(file);
    } catch {
      return { valid: false, events: 0, reason: 'log contains a line that is not valid JSON' };
    }
    let previous = GENESIS;
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!;
      const { hash, ...body } = event;
      if (event.seq !== index + 1) {
        return { valid: false, events: events.length, brokenAt: index + 1, reason: 'sequence gap or reordering' };
      }
      if (event.prevHash !== previous) {
        return { valid: false, events: events.length, brokenAt: event.seq, reason: 'previous-hash link does not match' };
      }
      if (eventHash(body) !== hash) {
        return { valid: false, events: events.length, brokenAt: event.seq, reason: 'event content does not match its hash' };
      }
      previous = hash;
    }
    return { valid: true, events: events.length };
  }
}
