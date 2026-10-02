import { spawn } from 'node:child_process';

export interface CommandSpec {
  /** Program and arguments. Fixed in configuration; agents choose a command by id and cannot change it. */
  argv: string[];
  timeoutMs: number;
}

export interface CommandResult {
  id: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The end of the combined output, which is where compilers and test runners report failures. */
  output: string;
}

const OUTPUT_TAIL_BYTES = 12_000;

/** Environment variables a build tool needs. Everything else, including any API key, is withheld. */
const PASSED_ENVIRONMENT = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
]);

export function sanitizedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: 'true', NO_COLOR: '1' };
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (PASSED_ENVIRONMENT.has(upper) || upper.startsWith('NPM_CONFIG_')) environment[name] = value;
  }
  return environment;
}

/**
 * Runs a fixed set of named commands in the workspace.
 *
 * This is the only way anything in the orchestrator starts a process. There is no shell and no
 * free-form command: an agent cannot ask for something that is not on the list. The commands do
 * run code the agents wrote (the tests), so the process gets a scrubbed environment and a timeout.
 * That limits what leaks and how long it runs; it is not a sandbox.
 */
export class CommandRunner {
  private readonly commands: Record<string, CommandSpec>;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(commands: Record<string, CommandSpec>, environment: NodeJS.ProcessEnv = sanitizedEnvironment()) {
    this.commands = commands;
    this.environment = environment;
  }

  has(id: string): boolean {
    return id in this.commands;
  }

  run(id: string, cwd: string, signal: AbortSignal, substitutions: Record<string, string> = {}): Promise<CommandResult> {
    const spec = this.commands[id];
    if (!spec) return Promise.reject(new Error(`Command "${id}" is not on the allowlist.`));

    const argv = spec.argv.map((part) => part.replace(/\{(\w+)\}/g, (_, key: string) => substitutions[key] ?? `{${key}}`));
    const started = Date.now();

    return new Promise((resolvePromise, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: this.environment,
        // npm is a .cmd shim on Windows and needs the shell there. The arguments are fixed, never user input.
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      const collect = (chunk: Buffer): void => {
        output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_BYTES);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      let timedOut = false;
      const kill = (): void => void child.kill('SIGKILL');
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, spec.timeoutMs);
      signal.addEventListener('abort', kill, { once: true });

      child.on('error', (error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', kill);
        reject(new Error(`Could not start "${argv[0]}": ${error.message}`));
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', kill);
        resolvePromise({ id, exitCode, timedOut, durationMs: Date.now() - started, output });
      });
    });
  }
}

/** The commands the build-verify stage may run against a Node.js service. */
export const NODE_SERVICE_COMMANDS: Record<string, CommandSpec> = {
  // --ignore-scripts: dependencies are installed without running their install hooks.
  install: { argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 180_000 },
  typecheck: { argv: ['npm', 'run', 'typecheck', '--silent'], timeoutMs: 120_000 },
  test: { argv: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile={resultsFile}'], timeoutMs: 180_000 },
};
