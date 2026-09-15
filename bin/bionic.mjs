#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv.slice(2);
if (input.includes('--help')) {
  console.log(
    'Usage: bionic [--model MODEL] [--provider PROVIDER] [--thinking LEVEL] [--print] [task]\nRuns Pi with only the ten Bionic script tools. Requires a model provider API key in the environment.',
  );
  process.exit(0);
}
const allowedValues = new Set(['--model', '--provider', '--thinking', '--name']);
const allowedFlags = new Set(['--print', '-p', '--no-session']);
const options = [],
  prompts = [];
for (let i = 0; i < input.length; i++) {
  const arg = input[i];
  if (allowedValues.has(arg)) {
    if (!input[i + 1] || input[i + 1].startsWith('-')) {
      throw new Error(`Missing value: ${arg}`);
    }
    options.push(arg, input[++i]);
  } else if (allowedFlags.has(arg)) {
    options.push(arg);
  } else if (arg.startsWith('-') || arg.startsWith('@')) {
    throw new Error(`Unsupported launcher argument: ${arg}`);
  } else {
    prompts.push(arg);
  }
}
const config = mkdtempSync(join(tmpdir(), 'bionic-pi-'));
const dataRoot = resolve('.bionic');
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
  '..',
);
const promptSource = readFileSync(join(root, 'lib/prompt.ts'), 'utf8');
const prompt = promptSource.slice(promptSource.indexOf('`') + 1, promptSource.lastIndexOf('`'));
const args = [
  join(packageRoot, 'dist/bundle/cli.js'),
  '--no-builtin-tools',
  '--no-extensions',
  '-e',
  join(root, 'extensions/bionic.ts'),
  '--no-context-files',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-approve',
  '--system-prompt',
  prompt,
  '--session-dir',
  join(dataRoot, 'sessions'),
  ...options,
  ...prompts,
];
const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: config,
    BIONIC_CONTROLLED: '1',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  },
});
const cleanup = () => rmSync(config, { recursive: true, force: true });
child.on('error', (e) => {
  cleanup();
  console.error(e.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  cleanup();
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
