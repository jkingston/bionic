import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { resolve } from 'node:path';
import { TOOL_NAMES, failure, type ToolName } from '../lib/contracts.ts';
import { schemas, descriptions } from '../lib/schemas.ts';
import { OPERATING_PROMPT } from '../lib/prompt.ts';
import { createRuntime, type RuntimeWork, type RuntimePolicy } from '../lib/runtime/index.ts';
import { moduleDiscovery } from '../lib/pi/modules.ts';

export function createBionicExtension(policy: RuntimePolicy = {}) {
  return function bionic(pi: ExtensionAPI) {
    const discoverModules = moduleDiscovery(pi);
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let work: RuntimeWork | undefined;
    async function dispose() {
      const previous = runtime;
      runtime = undefined;
      work?.cancel();
      work = undefined;
      await previous?.dispose();
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
      runtime = await createRuntime({
        root: resolve(ctx.cwd, '.bionic'),
        modules: discoverModules(),
        policy,
      });
      pi.setActiveTools([...TOOL_NAMES]);
      checkTools();
      ctx.ui.setStatus('bionic', 'Bionic · WASM · script tools');
    });
    pi.on('before_agent_start', async (event) => {
      work?.cancel();
      work = undefined;
      checkTools();
      if (!runtime) {
        throw new Error('Bionic failed to initialize');
      }
      work = runtime.beginWork({ task: event.prompt });
      // Static operating instructions only: no facts, memory, or registry inventory.
      return { systemPrompt: OPERATING_PROMPT };
    });
    pi.on('tool_call', () => {
      try {
        checkTools();
        if (!runtime || !work) {
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
            if (!runtime || !work) {
              throw new Error('Bionic is not initialized');
            }
            const result = await work.invoke(name as ToolName, args, {
              requestId: toolCallId,
              signal,
            });
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
        if (!runtime) {
          ctx.ui.notify('Bionic is not initialized', 'error');
          return;
        }
        const text =
          args.trim() === 'runs'
            ? JSON.stringify(await runtime.recent(10), null, 2)
            : JSON.stringify(
                {
                  registryId: runtime.registryId,
                  root: resolve(ctx.cwd, '.bionic'),
                  runtime: 'QuickJS in WASM',
                  work: work ? { id: work.id, usage: work.usage } : null,
                },
                null,
                2,
              );
        ctx.ui.notify(text, 'info');
      },
    });
  };
}

export default createBionicExtension();

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
