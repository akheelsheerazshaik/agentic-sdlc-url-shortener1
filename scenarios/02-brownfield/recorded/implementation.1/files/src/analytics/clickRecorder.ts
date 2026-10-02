import type { StatementSync } from 'node:sqlite';
import { inTransaction, type Database } from '../db/database.ts';

export interface ClickEvent {
  code: string;
  clickedAt: string;
  referrerHost: string | null;
}

export interface ClickRecorderOptions {
  flushIntervalMs: number;
  /** Upper bound on buffered events. Beyond it, events are dropped so memory stays bounded under load. */
  maxQueue: number;
}

/**
 * Buffers click events in memory and writes them in batches.
 *
 * Redirects are the hot path and must not wait on an analytics write, so recording a click is an
 * in-memory push. The cost is that analytics are best-effort: events can be dropped when the queue
 * is full, and events still buffered when the process is killed without a graceful shutdown are lost.
 */
export class ClickRecorder {
  private readonly db: Database;
  private readonly options: ClickRecorderOptions;
  private readonly insertEvent: StatementSync;
  private readonly incrementCount: StatementSync;
  private queue: ClickEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private droppedCount = 0;

  constructor(db: Database, options: ClickRecorderOptions) {
    this.db = db;
    this.options = options;
    this.insertEvent = db.prepare(
      'INSERT INTO click_events (code, clicked_at, referrer_host) VALUES (?, ?, ?)',
    );
    this.incrementCount = db.prepare('UPDATE links SET click_count = click_count + ? WHERE code = ?');
  }

  record(event: ClickEvent): void {
    if (this.queue.length >= this.options.maxQueue) {
      this.droppedCount++;
      return;
    }
    this.queue.push(event);
  }

  /** Writes everything buffered in one transaction, so the events and the running totals cannot disagree. */
  flush(): number {
    if (this.queue.length === 0) return 0;
    const batch = this.queue;
    this.queue = [];

    const perCode = new Map<string, number>();
    try {
      inTransaction(this.db, () => {
        for (const event of batch) {
          this.insertEvent.run(event.code, event.clickedAt, event.referrerHost);
          perCode.set(event.code, (perCode.get(event.code) ?? 0) + 1);
        }
        for (const [code, count] of perCode) {
          this.incrementCount.run(count, code);
        }
      });
    } catch (error) {
      // Put the batch back so a transient database error does not lose it, within the queue bound.
      const room = Math.max(0, this.options.maxQueue - this.queue.length);
      this.queue = batch.slice(0, room).concat(this.queue);
      this.droppedCount += batch.length - Math.min(batch.length, room);
      throw error;
    }
    return batch.length;
  }

  start(onError: (error: unknown) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch (error) {
        onError(error);
      }
    }, this.options.flushIntervalMs);
    // Do not keep the process alive just for the flush timer.
    this.timer.unref();
  }

  /** Stops the timer and writes whatever is still buffered. Called on graceful shutdown. */
  close(): number {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this.flush();
  }

  get pending(): number {
    return this.queue.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}

/** Reduces a Referer header to its host. The full URL can carry personal data in its path or query. */
export function referrerHost(header: string | undefined): string | null {
  if (!header) return null;
  try {
    return new URL(header).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
