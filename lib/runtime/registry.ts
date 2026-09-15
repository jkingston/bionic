import {
  BionicError,
  type Capability,
  type CapabilityProvider,
  type Grant,
  type Json,
  type ProviderContext,
} from '../contracts.ts';
import { checkSchema } from '../validation.ts';
import { abortable } from '../abort.ts';

import type { RuntimeModule, RuntimePolicy } from './types.ts';
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/;
function providerError(error: unknown): BionicError {
  // Separate installed SDK copies have different Error constructors.
  const e = error as { name?: string; code?: string; message?: string } | null;
  if (
    e?.name === 'BionicError' &&
    typeof e.message === 'string' &&
    [
      'permission_required',
      'forbidden',
      'not_found',
      'invalid_input',
      'limit',
      'cancelled',
      'provider_error',
    ].includes(e.code ?? '')
  ) {
    return new BionicError(e.code!, e.message);
  }
  return new BionicError('provider_error', 'Platform API failed');
}
export function validateModule(value: unknown): asserts value is RuntimeModule {
  const r = value as RuntimeModule;
  if (!r || typeof r.id !== 'string' || !identifier.test(r.id)) {
    throw new BionicError('configuration', 'Invalid module ID');
  }
  if (
    !Array.isArray(r.capabilities) ||
    typeof r.invoke !== 'function' ||
    (r.authorize !== undefined && typeof r.authorize !== 'function') ||
    (r.dispose !== undefined && typeof r.dispose !== 'function')
  ) {
    throw new BionicError('configuration', `Invalid module interface: ${r.id}`);
  }
}

export class ModuleRegistry implements CapabilityProvider {
  private routes = new Map<string, RuntimeModule>();
  private catalog: Capability[] = [];
  private registrations: RuntimeModule[] = [];
  private controller = new AbortController();
  private closing?: Promise<void>;
  private state: 'collecting' | 'ready' | 'failed' | 'closed' = 'collecting';
  private ids = new Set<string>();
  private owned = new Set<RuntimeModule>();
  private errors: string[] = [];

  constructor(private policy: RuntimePolicy = {}) {}

  offer(value: unknown): { accepted: boolean; error?: string } {
    if (this.state !== 'collecting') {
      return { accepted: false, error: 'Module registry is not collecting' };
    }
    try {
      validateModule(value);
      // Even a duplicate module belongs to this failed runtime and must be cleaned up.
      if (!this.owned.has(value)) {
        this.owned.add(value);
        this.registrations.push({ ...value, dispose: value.dispose?.bind(value) });
      }
      if (this.ids.has(value.id)) {
        throw new Error('Duplicate module ID');
      }
      // Take ownership before metadata validation so failed startup also cleans up.
      this.ids.add(value.id);
      const definitions = structuredClone(value.capabilities);
      if (
        !Array.isArray(definitions) ||
        definitions.length > 100 ||
        Buffer.byteLength(JSON.stringify(definitions)) > 262144
      ) {
        throw new Error('Invalid capability catalog');
      }
      const names = new Set(this.routes.keys());
      for (const d of definitions) {
        if (
          !d ||
          typeof d.name !== 'string' ||
          !identifier.test(d.name) ||
          typeof d.description !== 'string' ||
          d.description.length > 4000 ||
          !Number.isSafeInteger(d.version) ||
          d.version < 1 ||
          d.effect !== 'read'
        ) {
          throw new Error('Invalid capability definition');
        }
        if (['work.current', 'policy.describe'].includes(d.name) || names.has(d.name)) {
          throw new Error('Duplicate or reserved capability');
        }
        names.add(d.name);
        checkSchema(d.inputSchema);
        checkSchema(d.outputSchema);
      }
      for (const definition of definitions) {
        this.routes.set(definition.name, {
          id: value.id,
          capabilities: [],
          authorize: value.authorize?.bind(value),
          invoke: value.invoke.bind(value),
        });
      }
      this.catalog.push(...definitions);
      return { accepted: true };
    } catch {
      // Configuration exceptions can contain credentials supplied by host SDKs.
      const message = 'Invalid, duplicate, reserved or incompatible module registration';
      this.errors.push(message);
      return { accepted: false, error: message };
    }
  }
  seal() {
    if (this.state !== 'collecting') {
      throw new BionicError('configuration', 'Registry already sealed');
    }
    this.state = this.errors.length ? 'failed' : 'ready';
    this.assertReady();
  }
  private assertReady() {
    if (this.state !== 'ready') {
      throw new BionicError(
        'configuration',
        this.errors.join('; ') || 'Module registry unavailable',
      );
    }
  }
  definitions() {
    this.assertReady();
    return structuredClone(this.catalog);
  }
  authorize(name: string, args: Json, _grant: Grant, context?: ProviderContext) {
    this.assertReady();
    const route = this.routes.get(name);
    if (!route) {
      throw new BionicError('forbidden', 'Unknown module capability');
    }
    if (!context) {
      throw new BionicError('configuration', 'Missing host call context');
    }
    const call = { ...context };
    return (async () => {
      try {
        await this.policy.authorize?.(name, structuredClone(args), call);
        context.signal.throwIfAborted();
        await route.authorize?.(name, structuredClone(args), call);
      } catch (error) {
        throw providerError(error);
      }
    })();
  }
  async invoke(name: string, args: Json, context: ProviderContext) {
    this.assertReady();
    const route = this.routes.get(name);
    if (!route) {
      throw new BionicError('forbidden', 'Unknown module capability');
    }
    const signal = AbortSignal.any([context.signal, this.controller.signal]);
    const call = { ...context };
    try {
      return await abortable(
        () => route.invoke(name, structuredClone(args), { ...call, signal }),
        signal,
      );
    } catch (error) {
      throw providerError(error);
    }
  }
  dispose(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.state = 'closed';
    this.controller.abort();
    this.closing = (async () => {
      const signal = AbortSignal.timeout(1000);
      const outcomes = await Promise.allSettled(
        this.registrations.map((r) =>
          abortable(() => r.dispose?.(signal) ?? Promise.resolve(), signal),
        ),
      );
      if (outcomes.some((o) => o.status === 'rejected')) {
        throw new BionicError('provider_error', 'Module cleanup failed or exceeded 1000ms');
      }
    })();
    return this.closing;
  }
}
