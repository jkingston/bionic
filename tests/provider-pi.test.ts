import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { TOOL_NAMES } from '../lib/contracts.ts';
import { defaultGrant } from '../lib/policy.ts';
import { basic } from './helpers.ts';
import { OPERATING_PROMPT } from '../lib/prompt.ts';
import { registerBionicProvider, createClockProvider } from '../lib/providers/index.ts';

const ai = await import(
  new URL(
    '../node_modules/@earendil-works/pi-ai/dist/index.js',
    import.meta.resolve('@earendil-works/pi-coding-agent'),
  ).href
);

test('production extensions: discovery, WASM composition, reload, fresh sessions and blocked startup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bionic-providers-pi-'));
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir);
  const previous = {
    controlled: process.env.BIONIC_CONTROLLED,
    deployment: process.env.BIONIC_DEPLOYMENT,
  };
  process.env.BIONIC_CONTROLLED = '1';
  process.env.BIONIC_DEPLOYMENT = join(dir, 'deployment.json');
  t.after(() => {
    for (const [key, value] of [
      ['BIONIC_CONTROLLED', previous.controlled],
      ['BIONIC_DEPLOYMENT', previous.deployment],
    ]) {
      if (value === undefined) {
        delete process.env[key!];
      } else {
        process.env[key!] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  const faux = ai.fauxProvider({ provider: 'provider-tests', tokensPerSecond: Infinity });
  runtime.registerNativeProvider(faux.provider);
  let disposals = 0;
  let staleApi: ExtensionAPI | undefined;
  const lifecycle = (pi: ExtensionAPI) => {
    staleApi = pi;
    registerBionicProvider(pi, {
      protocolVersion: 1,
      id: 'lifecycle',
      provider: { definitions: () => [], authorize() {}, invoke: async () => null },
      dispose: async () => {
        disposals++;
      },
    });
  };
  for (const scenario of ['core-first', 'provider-first', 'missing', 'duplicate'] as const) {
    const grant = defaultGrant();
    grant.capabilities.push('clock.now');
    writeFileSync(
      process.env.BIONIC_DEPLOYMENT!,
      JSON.stringify({
        extensions: [],
        requiredProviders: [
          'bionic.clock',
          'bionic.fake-sre',
          'lifecycle',
          ...(scenario === 'missing' ? ['absent'] : []),
        ],
        grant,
      }),
    );
    let paths = ['extensions/bionic.ts', 'extensions/clock.ts', 'extensions/fake-sre.ts'].map((p) =>
      resolve(p),
    );
    if (scenario === 'provider-first') {
      paths = paths.reverse();
    }
    const factories = [lifecycle];
    if (scenario === 'duplicate') {
      factories.push((pi) => registerBionicProvider(pi, createClockProvider()));
    }
    const settings = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      additionalExtensionPaths: paths,
      extensionFactories: factories,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir,
      resourceLoader: loader,
      settingsManager: settings,
      modelRuntime: runtime,
      model: faux.getModel(),
      noTools: 'builtin',
      sessionManager: SessionManager.inMemory(dir),
    });
    const errors: any[] = [];
    const before: number = disposals;
    try {
      await session.bindExtensions({ onError: (e) => errors.push(e) });
      if (scenario === 'missing' || scenario === 'duplicate') {
        assert.ok(errors.length > 0);
        faux.setResponses([
          ai.fauxAssistantMessage(
            ai.fauxToolCall('write', {
              path: 'should-not-exist.js',
              source: 'export function main(){return 1}',
              contract: basic,
              expectedVersion: null,
            }),
            { stopReason: 'toolUse' },
          ),
          (context: any) => {
            const last = context.messages.filter((m: any) => m.role === 'toolResult').at(-1);
            assert.equal(last.isError, true);
            return ai.fauxAssistantMessage('Blocked');
          },
        ]);
        await session.prompt('Try a write despite failed startup');
        assert.equal(faux.getPendingResponseCount(), 0);
        assert.equal((session.messages.at(-1) as any).stopReason, 'stop');
        assert.equal((session.messages.at(-1) as any).content[0].text, 'Blocked');
        continue;
      }
      for (let pass = 0; pass < 2; pass++) {
        assert.deepEqual(session.getActiveToolNames().sort(), [...TOOL_NAMES].sort());
        const steps: any[] = [
          (context: any) => {
            assert.equal(context.systemPrompt, OPERATING_PROMPT);
            return ai.fauxAssistantMessage(ai.fauxToolCall('capabilities', {}), {
              stopReason: 'toolUse',
            });
          },
          (context: any) => {
            const result = JSON.parse(
              context.messages.filter((m: any) => m.role === 'toolResult').at(-1).content[0].text,
            );
            assert.equal(result.apis.filter((d: any) => d.name === 'clock.now').length, 1);
            if (scenario === 'core-first' && pass === 0) {
              return ai.fauxAssistantMessage(
                ai.fauxToolCall('write', {
                  path: 'platform.js',
                  expectedVersion: null,
                  source:
                    'export async function main(host){return {time:await host.invoke("clock.now",{}),service:await host.invoke("service.get",{name:"checkout"})}}',
                  contract: {
                    ...basic,
                    capabilities: [
                      { name: 'clock.now', version: 1 },
                      { name: 'service.get', version: 1 },
                    ],
                  },
                }),
                { stopReason: 'toolUse' },
              );
            }
            return ai.fauxAssistantMessage(ai.fauxToolCall('read', { path: 'platform.js' }), {
              stopReason: 'toolUse',
            });
          },
          (context: any) => {
            const artifact = JSON.parse(
              context.messages.filter((m: any) => m.role === 'toolResult').at(-1).content[0].text,
            );
            return ai.fauxAssistantMessage(
              ai.fauxToolCall('execute', { ref: artifact.ref, input: {} }),
              { stopReason: 'toolUse' },
            );
          },
          (context: any) => {
            const run = JSON.parse(
              context.messages.filter((m: any) => m.role === 'toolResult').at(-1).content[0].text,
            );
            assert.equal(run.status, 'success');
            assert.equal(run.output.service.name, 'checkout');
            assert.ok(Number.isFinite(Date.parse(run.output.time.utc)));
            return ai.fauxAssistantMessage('Complete');
          },
        ];
        faux.setResponses(steps);
        await session.prompt(`Run ${scenario} ${pass}`);
        assert.equal(faux.getPendingResponseCount(), 0);
        assert.equal(
          (session.messages.at(-1) as any).stopReason,
          'stop',
          JSON.stringify(session.messages),
        );
        assert.equal((session.messages.at(-1) as any).content[0].text, 'Complete');
        if (pass === 0) {
          const old = staleApi!;
          await session.reload();
          assert.throws(() => old.events.emit('probe', {}), /stale|inactive|disposed/i);
          assert.equal(disposals, before + 1);
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  }
  // No denied write was published even though Pi continued after startup errors.
  const { SqliteStore } = await import('../lib/adapters/sqlite.ts');
  const store = new SqliteStore(join(dir, '.bionic/registry.sqlite'));
  try {
    await assert.rejects(store.read('should-not-exist.js'), { code: 'not_found' });
  } finally {
    store.close();
  }
});

test('provider without Bionic produces an explicit diagnostic', async () => {
  const { createEventBus } = await import('@earendil-works/pi-coding-agent');
  const handlers = new Map<string, any>();
  const messages: string[] = [];
  registerBionicProvider(
    {
      events: createEventBus(),
      on: (name: string, handler: unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI,
    createClockProvider(),
  );
  handlers.get('session_start')(
    {},
    { ui: { notify: (message: string) => messages.push(message) } },
  );
  assert.match(messages[0], /Bionic is missing/);
  await handlers.get('session_shutdown')();
});
