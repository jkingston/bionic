#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv.slice(2);
if (input.includes('--help')) {
  console.log(`Usage: bionic [--deployment FILE] [--isolated] [--provider PROVIDER] [--model MODEL]
              [--thinking LEVEL] [--print] [task]
Uses configured Pi credentials and the Bionic demo extensions by default.
--deployment loads an explicit extension list and grants from deployment JSON.
--isolated uses temporary Pi configuration and environment credentials.
Run npm ci in a source checkout before starting.`);
  process.exit(0);
}
if (!existsSync(join(root, 'dist/lib/deployment.js'))) {
  throw new Error('Bionic is not built. Run mise run setup (or npm ci) in the repository.');
}
const { readDeployment } = await import('../dist/lib/deployment.js');
const { OPERATING_PROMPT } = await import('../dist/lib/prompt.js');
const allowedValues = new Set(['--model', '--provider', '--thinking', '--name']);
const allowedFlags = new Set(['--print', '-p', '--no-session', '--list-models']);
const options = [],
  prompts = [];
let deploymentPath,
  isolated = false;
for (let i = 0; i < input.length; i++) {
  const arg = input[i];
  if (arg === '--isolated') {
    isolated = true;
  } else if (arg === '--deployment' || allowedValues.has(arg)) {
    if (!input[i + 1] || input[i + 1].startsWith('-')) {
      throw new Error(`Missing value: ${arg}`);
    }
    const value = input[++i];
    if (arg === '--deployment') {
      deploymentPath = resolve(value);
    } else {
      options.push(arg, value);
    }
  } else if (allowedFlags.has(arg)) {
    options.push(arg);
  } else if (arg.startsWith('-') || arg.startsWith('@')) {
    throw new Error(`Unsupported launcher argument: ${arg}`);
  } else {
    prompts.push(arg);
  }
}
let packageRoot;
try {
  packageRoot = resolve(
    dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
    '..',
  );
} catch {
  throw new Error('Pi dependency is missing. Run mise run setup (or npm ci).');
}
const extraExtensions = deploymentPath
  ? readDeployment(deploymentPath).extensions
  : ['fake-sre', 'clock', 'catalog'].map((name) => join(root, `dist/extensions/${name}.js`));
for (const path of extraExtensions) {
  if (!existsSync(path)) {
    throw new Error(`Deployment extension does not exist: ${path}`);
  }
}
const config = isolated ? mkdtempSync(join(tmpdir(), 'bionic-pi-')) : undefined;
const dataRoot = resolve('.bionic');
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const args = [
  join(packageRoot, 'dist/bundle/cli.js'),
  '--no-builtin-tools',
  '--no-extensions',
  '-e',
  join(root, 'dist/extensions/bionic.js'),
  ...extraExtensions.flatMap((path) => ['-e', path]),
  '--no-context-files',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-approve',
  '--system-prompt',
  OPERATING_PROMPT,
  '--session-dir',
  join(dataRoot, 'sessions'),
  ...options,
  ...prompts,
];
const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(config ? { PI_CODING_AGENT_DIR: config } : {}),
    BIONIC_CONTROLLED: '1',
    BIONIC_DEPLOYMENT: deploymentPath ?? '',
    BIONIC_DEMO: deploymentPath ? '0' : '1',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  },
});
const cleanup = () => {
  if (config) {
    rmSync(config, { recursive: true, force: true });
  }
};
child.on('error', (error) => {
  cleanup();
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  cleanup();
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
