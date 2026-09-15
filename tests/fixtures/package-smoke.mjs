// Copied into a temporary deployment by package.test.ts. Only public package imports.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
const piEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
const ai = await import(
  new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', piEntry).href
);
const cwd = process.cwd(),
  agentDir = resolve('agent');
mkdirSync(agentDir);
const core = fileURLToPath(import.meta.resolve('bionic-pi'));
const platform = resolve('node_modules/test-platform/index.mjs');
process.env.BIONIC_CONTROLLED = '1';
const { createRuntime } = await import('bionic-pi/runtime');
const { module: externalModule } = await import('./node_modules/test-platform/index.mjs');
const headless = await createRuntime({ root: resolve('headless-data'), modules: [externalModule] });
try {
  const work = headless.beginWork({ task: 'No Pi required' });
  const artifact = await work.invoke('write', {
    path: 'headless.js',
    expectedVersion: null,
    source: 'export async function main(host){return host.invoke("external.echo",{})}',
    contract: {
      description: 'Headless',
      inputSchema: {},
      outputSchema: {},
      tools: [],
      fixtures: [],
      capabilities: [{ name: 'external.echo', version: 1 }],
    },
  });
  const result = await work.invoke('execute', { ref: artifact.ref, input: {} });
  assert.deepEqual(result.output, { external: true, principal: 'local' });
} finally {
  await headless.dispose();
}
const runtime = await ModelRuntime.create({
  authPath: resolve(agentDir, 'auth.json'),
  modelsPath: null,
  modelsStorePath: resolve(agentDir, 'models.json'),
  refreshOnCreate: false,
});
const faux = ai.fauxProvider({ provider: 'package-test', tokensPerSecond: Infinity });
runtime.registerNativeProvider(faux.provider);
const settings = SettingsManager.inMemory({
  retry: { enabled: false },
  compaction: { enabled: false },
});
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  additionalExtensionPaths: [platform, core],
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader: loader,
  settingsManager: settings,
  modelRuntime: runtime,
  model: faux.getModel(),
  noTools: 'builtin',
  sessionManager: SessionManager.inMemory(cwd),
});
const errors = [];
try {
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  assert.equal(session.getActiveToolNames().length, 11);
  let ref;
  const tool = (name, args) =>
    ai.fauxAssistantMessage(ai.fauxToolCall(name, args), { stopReason: 'toolUse' });
  const last = (context) =>
    JSON.parse(context.messages.filter((m) => m.role === 'toolResult').at(-1).content[0].text);
  faux.setResponses([
    tool('capabilities', {}),
    (context) => {
      assert.ok(last(context).apis.some((d) => d.name === 'external.echo'));
      return tool('write', {
        path: 'external.js',
        expectedVersion: null,
        source:
          'export async function main(host,input){try{return await host.invoke("external.echo",input)}catch(e){return {denied:e.code}}}',
        contract: {
          description: 'External API',
          inputSchema: {},
          outputSchema: {},
          tools: [],
          fixtures: [],
          capabilities: [{ name: 'external.echo', version: 1 }],
        },
      });
    },
    (context) => {
      ref = last(context).ref;
      return tool('execute', { ref, input: {} });
    },
    (context) => {
      assert.deepEqual(last(context).output, { external: true, principal: 'local' });
      return tool('execute', { ref, input: { deny: true } });
    },
    (context) => {
      assert.equal(last(context).output.denied, 'permission_required');
      return ai.fauxAssistantMessage('Done');
    },
  ]);
  await session.prompt('Use the external API');
  assert.equal(faux.getPendingResponseCount(), 0, JSON.stringify(session.messages));
  assert.equal(session.messages.at(-1).stopReason, 'stop', JSON.stringify(session.messages));
  assert.equal(session.messages.at(-1).content[0].text, 'Done');
  assert.deepEqual(errors, []);
  console.log('External deployment passed');
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
