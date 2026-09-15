import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { resolve } from 'node:path';
import { openApplication } from '../lib/application.ts';
import { TOOL_NAMES, failure, type Invocation, type ToolName } from '../lib/contracts.ts';
import { newWork } from '../lib/policy.ts';
import { schemas, descriptions } from '../lib/schemas.ts';
import { OPERATING_PROMPT } from '../lib/prompt.ts';
import { ProviderRegistry } from '../lib/providers/registry.ts';
import { providerDiscovery } from '../lib/providers/pi.ts';
import { deploymentPolicy } from '../lib/deployment.ts';

export default function bionic(pi: ExtensionAPI) {
  const discoverProviders = providerDiscovery(pi);
  let registry: ProviderRegistry | undefined;
  let ready = false;
  let app: ReturnType<typeof openApplication> | undefined;
  let work: Invocation | undefined;
  let sessionAbort = new AbortController();
  const inflight = new Set<Promise<unknown>>();
  async function dispose() {
    ready = false;
    sessionAbort.abort();
    await Promise.allSettled([...inflight]);
    try {
      await registry?.dispose();
    } finally {
      app?.store.close();
      app = undefined;
      work = undefined;
      registry = undefined;
    }
  }
  const checkTools = () => {
    const active = pi.getActiveTools().sort();
    if (active.join(',') !== [...TOOL_NAMES].sort().join(',')) {
      throw new Error(
        'Bionic requires exactly its ten script tools; restart using the bionic launcher.',
      );
    }
  };
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.BIONIC_CONTROLLED !== '1') {
      throw new Error(
        'Start Bionic with npm start / the bionic launcher, not a normal Pi profile.',
      );
    }
    await dispose();
    sessionAbort = new AbortController();
    const root = resolve(ctx.cwd, '.bionic');
    registry = new ProviderRegistry();
    try {
      discoverProviders(registry, deploymentPolicy().requiredProviders);
      app = openApplication(root, registry, () => deploymentPolicy().grant);
      registry.validateGrant(app.readGrant());
      await app.seed();
      pi.setActiveTools([...TOOL_NAMES]);
      checkTools();
      ready = true;
    } catch (error) {
      await dispose();
      throw error;
    }
    ctx.ui.setStatus('bionic', 'Bionic · WASM · script tools');
  });
  pi.on('before_agent_start', async (event) => {
    work = undefined;
    checkTools();
    if (!ready || !app || !registry) {
      throw new Error('Bionic failed to initialize');
    }
    const grant = app.readGrant();
    registry.validateGrant(grant);
    work = newWork(grant, { task: event.prompt });
    // Static operating instructions only: no facts, memory, or registry inventory.
    return { systemPrompt: OPERATING_PROMPT };
  });
  pi.on('tool_call', () => {
    try {
      checkTools();
      if (!ready || !app || !work) {
        throw new Error('Bionic is not ready');
      }
    } catch (e) {
      return { block: true, reason: String(e) };
    }
  });
  pi.on('user_bash', () => ({
    result: {
      output: 'Bionic executes saved scripts only. Shell commands are unavailable.',
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  }));
  pi.on('session_shutdown', dispose);
  for (const name of TOOL_NAMES) {
    pi.registerTool({
      name,
      label: `Script ${name}`,
      description: descriptions[name],
      parameters: schemas[name],
      executionMode: 'sequential',
      renderCall(args) {
        return block(`${name} ${JSON.stringify(args)}`);
      },
      renderResult(result, options) {
        return block(
          JSON.stringify(result.details, null, options.expanded ? 2 : undefined),
          options.expanded ? 80 : 8,
        );
      },
      async execute(toolCallId, args, signal, _onUpdate, _ctx) {
        try {
          checkTools();
          if (!ready || !app || !work) {
            throw new Error('Bionic is not initialized');
          }
          const operation = app.service.invoke(
            name as ToolName,
            args,
            work,
            toolCallId,
            signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal,
          );
          inflight.add(operation);
          let result;
          try {
            result = await operation;
          } finally {
            inflight.delete(operation);
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } catch (e) {
          const error = failure(e);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error }) }],
            details: { error },
            isError: true,
          };
        }
      },
    });
  }
  pi.registerCommand('bionic', {
    description: 'Show Bionic registry, work budget, or recent run summaries (/bionic runs).',
    handler: async (args, ctx) => {
      if (!app) {
        ctx.ui.notify('Bionic is not initialized', 'error');
        return;
      }
      const text =
        args.trim() === 'runs'
          ? JSON.stringify(await app.store.recent(10), null, 2)
          : JSON.stringify(
              {
                registryId: app.store.registryId,
                root: resolve(ctx.cwd, '.bionic'),
                runtime: 'QuickJS in WASM',
                work: work ? { id: work.workId, usage: work.budget } : null,
              },
              null,
              2,
            );
      ctx.ui.notify(text, 'info');
    },
  });
}

// Own renderers avoid inheriting Pi's filesystem-tool result shapes. Escape
// non-ASCII/control bytes so script data cannot emit terminal control sequences.
function block(text: string | undefined, maxLines = 3) {
  const safe = (text ?? '').replace(
    /[^\x20-\x7e\n]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return {
    invalidate() {},
    render(width: number) {
      const lines: string[] = [];
      const columns = Math.max(1, width);
      for (const line of safe.split('\n')) {
        for (let i = 0; i < Math.max(1, line.length); i += columns) {
          if (lines.length === maxLines) {
            return [...lines.slice(0, -1), '...'.slice(0, columns)];
          }
          lines.push(line.slice(i, i + columns));
        }
      }
      return lines;
    },
  };
}
