import { randomUUID } from 'node:crypto';
import { BionicError, type Json } from '../contracts.ts';
import { coreGrant, newWork, validateGrant } from '../policy.ts';
import { openApplication } from '../application.ts';
import { ModuleRegistry } from './registry.ts';
import type { RuntimeModule, RuntimePolicy } from './types.ts';

export interface RuntimeOptions {
  root: string;
  modules?: RuntimeModule[];
  policy?: RuntimePolicy;
}
export interface RuntimeWork {
  readonly id: string;
  readonly usage: {
    calls: number;
    writes: number;
    sourceBytes: number;
    outputBytes: number;
    active: number;
    deadline: number;
  };
  invoke(
    name: string,
    args: unknown,
    options?: { requestId?: string; signal?: AbortSignal },
  ): Promise<Json>;
  cancel(): void;
}

/** Owns the script store, WASM execution, modules, work budgets and shutdown. No Pi. */
export async function createRuntime(options: RuntimeOptions) {
  const { authorize, ...data } = options.policy ?? {};
  const policy: RuntimePolicy = { ...structuredClone(data), authorize };
  const registry = new ModuleRegistry(policy);
  let app: ReturnType<typeof openApplication> | undefined;
  try {
    for (const module of options.modules ?? []) {
      registry.offer(module);
    }
    registry.seal();
    const available = [
      ...registry.definitions().map((d) => d.name),
      'work.current',
      'policy.describe',
    ];
    if (policy.capabilities?.some((name) => !available.includes(name))) {
      throw new BionicError('configuration', 'Policy references an unavailable capability');
    }
    const base = coreGrant();
    const grant = validateGrant({
      ...base,
      principal: policy.principal ?? 'local',
      capabilities: policy.capabilities ?? available,
      tools: policy.tools ?? base.tools,
      readPrefixes: policy.readPrefixes ?? base.readPrefixes,
      writePrefixes: policy.writePrefixes ?? base.writePrefixes,
      limits: { ...base.limits, ...policy.limits },
    });
    app = openApplication(options.root, registry);
    await app.seed();
    const application = app;
    const inflight = new Set<Promise<Json>>();
    const controllers = new Set<AbortController>();
    let closing: Promise<void> | undefined;
    return {
      registryId: application.store.registryId,
      capabilities: () => registry.definitions(),
      recent: (limit = 10) => application.store.recent(limit),
      beginWork(input: Json): RuntimeWork {
        if (closing) {
          throw new BionicError('cancelled', 'Runtime is closed');
        }
        const ctx = newWork(grant, input);
        const controller = new AbortController();
        controllers.add(controller);
        return {
          id: ctx.workId,
          get usage() {
            return { ...ctx.budget };
          },
          invoke(name, args, call = {}) {
            const signal = AbortSignal.any([
              controller.signal,
              ...(call.signal ? [call.signal] : []),
            ]);
            const operation = application.service.invoke(
              name,
              args,
              ctx,
              call.requestId ?? randomUUID(),
              signal,
            );
            inflight.add(operation);
            void operation.finally(() => inflight.delete(operation)).catch(() => {});
            return operation;
          },
          cancel() {
            controller.abort();
            controllers.delete(controller);
          },
        };
      },
      dispose(): Promise<void> {
        if (!closing) {
          for (const controller of controllers) {
            controller.abort();
          }
          controllers.clear();
          closing = (async () => {
            await Promise.allSettled([...inflight]);
            try {
              await registry.dispose();
            } finally {
              application.store.close();
            }
          })();
        }
        return closing;
      },
    };
  } catch (error) {
    try {
      await registry.dispose();
    } finally {
      app?.store.close();
    }
    throw error;
  }
}
