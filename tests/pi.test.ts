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
} from '@earendil-works/pi-coding-agent';
import { TOOL_NAMES } from '../lib/contracts.ts';
import { OPERATING_PROMPT } from '../lib/prompt.ts';
import { basic } from './helpers.ts';

// Use the exact pi-ai instance belonging to the pinned Pi installation.
const ai = await import(
  new URL(
    '../node_modules/@earendil-works/pi-ai/dist/index.js',
    import.meta.resolve('@earendil-works/pi-coding-agent'),
  ).href
);
test('real Pi loader and agent loop use script tools and API context in fresh sessions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bionic-pi-test-'));
  const agentDir = join(dir, 'config');
  mkdirSync(agentDir);
  writeFileSync(join(dir, 'AGENTS.md'), 'SECRET_CONTEXT_SENTINEL');
  const previous = process.env.BIONIC_CONTROLLED;
  process.env.BIONIC_CONTROLLED = '1';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BIONIC_CONTROLLED;
    } else {
      process.env.BIONIC_CONTROLLED = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(agentDir, 'models-cache.json'),
    refreshOnCreate: false,
  });
  const faux = ai.fauxProvider({ provider: 'bionic-test', tokensPerSecond: Infinity });
  runtime.registerNativeProvider(faux.provider);
  for (let pass = 0; pass < 2; pass++) {
    const settings = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      additionalExtensionPaths: [resolve('extensions/bionic.ts')],
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: OPERATING_PROMPT,
    });
    await loader.reload();
    assert.equal(
      loader.getExtensions().errors.length,
      0,
      JSON.stringify(loader.getExtensions().errors),
    );
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
    try {
      await session.bindExtensions({ onError: (e) => errors.push(e) });
      assert.deepEqual(session.getActiveToolNames().sort(), [...TOOL_NAMES].sort());
      const inspect = (context: any) => {
        assert.equal(context.systemPrompt, OPERATING_PROMPT);
        assert.ok(!JSON.stringify(context).includes('SECRET_CONTEXT_SENTINEL'));
        assert.deepEqual(context.tools.map((x: any) => x.name).sort(), [...TOOL_NAMES].sort());
      };
      const steps: any[] = [];
      if (pass === 0) {
        steps.push((context: any) => {
          inspect(context);
          return ai.fauxAssistantMessage(
            ai.fauxToolCall('write', {
              path: 'scratch/from-pi.js',
              source: 'export async function main(host){return host.invoke("work.current",{})}',
              contract: { ...basic, capabilities: [{ name: 'work.current', version: 1 }] },
              expectedVersion: null,
            }),
            { stopReason: 'toolUse' },
          );
        });
      }
      steps.push((context: any) => {
        inspect(context);
        return ai.fauxAssistantMessage(ai.fauxToolCall('read', { path: 'scratch/from-pi.js' }), {
          stopReason: 'toolUse',
        });
      });
      steps.push((context: any) => {
        inspect(context);
        const last = context.messages.filter((m: any) => m.role === 'toolResult').at(-1);
        const artifact = JSON.parse(last.content[0].text);
        return ai.fauxAssistantMessage(
          ai.fauxToolCall('execute', { ref: artifact.ref, input: {} }),
          { stopReason: 'toolUse' },
        );
      });
      steps.push((context: any) => {
        inspect(context);
        const last = context.messages.filter((m: any) => m.role === 'toolResult').at(-1);
        const run = JSON.parse(last.content[0].text);
        assert.equal(run.status, 'success');
        assert.equal(run.output.input.task, `Task ${pass}`);
        return ai.fauxAssistantMessage('Complete');
      });
      faux.setResponses(steps);
      await session.prompt(`Task ${pass}`);
      assert.equal(faux.getPendingResponseCount(), 0);
      assert.deepEqual(errors, []);
      assert.equal(session.messages.at(-1)?.role, 'assistant');
      assert.equal((session.messages.at(-1) as any).stopReason, 'stop');
      assert.equal((session.messages.at(-1) as any).content[0].text, 'Complete');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  }
});
