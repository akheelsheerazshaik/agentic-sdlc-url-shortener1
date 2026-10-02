import type { Agent } from './types.ts';

/**
 * A deliberately injected failure, for demonstrating and testing the recovery paths.
 * `before`: the agent fails without doing anything. `after`: the agent does its work, including
 * any side effects, and then fails, which is what exercises compensation.
 */
export interface FaultSpec {
  stageId: string;
  when: 'before' | 'after';
  /** How many invocations fail. Infinity means every one. */
  times: number;
}

/** Parses `stage=error:2`, `stage=error:always`, `stage=error-after:1`. */
export function parseFault(text: string): FaultSpec {
  const match = /^([a-z-]+)=(error|error-after):(\d+|always)$/.exec(text);
  if (!match) {
    throw new Error(`Invalid fault "${text}". Use <stage>=error:<n|always> or <stage>=error-after:<n|always>.`);
  }
  return {
    stageId: match[1]!,
    when: match[2] === 'error' ? 'before' : 'after',
    times: match[3] === 'always' ? Infinity : Number(match[3]),
  };
}

/** Remembers how often each fault has fired. Kept on disk by the runtime so the count survives a resume. */
export interface FaultLedger {
  fired(stageId: string): number;
  record(stageId: string): void;
}

export function memoryLedger(): FaultLedger {
  const counts = new Map<string, number>();
  return {
    fired: (stageId) => counts.get(stageId) ?? 0,
    record: (stageId) => void counts.set(stageId, (counts.get(stageId) ?? 0) + 1),
  };
}

export function withFault(agent: Agent, fault: FaultSpec | undefined, ledger: FaultLedger = memoryLedger()): Agent {
  if (!fault) return agent;
  return {
    id: agent.id,
    async run(context) {
      const inject = ledger.fired(fault.stageId) < fault.times;
      if (inject) ledger.record(fault.stageId);
      if (inject && fault.when === 'before') throw new Error('injected fault: agent unavailable');
      const result = await agent.run(context);
      if (inject) throw new Error('injected fault: failure after the action was performed');
      return result;
    },
  };
}
