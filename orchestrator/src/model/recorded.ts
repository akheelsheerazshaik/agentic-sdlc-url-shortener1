import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StageFailure } from '../engine/types.ts';
import type { ModelGateway, ModelRequest, ModelResponse } from './gateway.ts';

interface ChangeManifest {
  summary: string;
  changes: { path: string; action: 'create' | 'modify' | 'delete'; taskIds: string[] }[];
  [extra: string]: unknown;
}

/**
 * Replays model replies recorded for a scenario, so a run is reproducible and needs no API key.
 *
 * A recording is looked up by stage and generation: `<stage>.<n>.json`, or a directory
 * `<stage>.<n>/` for change sets, where file contents live as real files under `files/` and are
 * assembled into the same JSON a live model would return. When a stage runs for a generation that
 * has no recording of its own, the latest earlier one is used.
 *
 * What this means for a reader: in this mode the *content* of each agent's reply is fixed in
 * advance. Everything around it is live: validation, gates, policies, the build, approvals,
 * retries and re-planning all run for real against that content.
 */
export class RecordedGateway implements ModelGateway {
  readonly id = 'recorded';
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const recording = this.find(request.stageId, request.generation);
    if (!recording) {
      throw new StageFailure(
        `no recorded reply for stage "${request.stageId}" in ${this.directory}. Offline mode needs a scenario with recordings; use live mode for a new requirement.`,
        { retryable: false },
      );
    }
    const text = statSync(recording.path).isDirectory() ? this.assembleChangeSet(recording.path) : readFileSync(recording.path, 'utf8');
    return { text, model: `recording:${recording.name}` };
  }

  /** The recording with the highest generation number not above the one asked for. */
  private find(stageId: string, generation: number): { path: string; name: string } | undefined {
    if (!existsSync(this.directory)) return undefined;
    const pattern = new RegExp(`^${stageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)(\\.json)?$`);
    let best: { path: string; name: string; number: number } | undefined;
    for (const entry of readdirSync(this.directory)) {
      const match = pattern.exec(entry);
      if (!match) continue;
      const number = Number(match[1]);
      if (number <= generation && (!best || number > best.number)) {
        best = { path: join(this.directory, entry), name: entry, number };
      }
    }
    return best;
  }

  private assembleChangeSet(directory: string): string {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as ChangeManifest;
    const changes = manifest.changes.map((change) =>
      change.action === 'delete'
        ? change
        : { ...change, content: readFileSync(join(directory, 'files', change.path), 'utf8') },
    );
    return JSON.stringify({ ...manifest, changes });
  }
}
