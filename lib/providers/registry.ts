import {
  BionicError,
  type Capability,
  type CapabilityProvider,
  type Grant,
  type Json,
  type ProviderContext,
  type Schema,
} from '../contracts.ts';
import { checkSchema, validate } from '../validation.ts';
import { abortable } from '../abort.ts';

export interface ProviderRegistration {
  protocolVersion: 1;
  id: string;
  provider: CapabilityProvider;
  /** Missing resource scopes are validated as {} and never imply full access. */
  scopeSchema?: Schema;
  /** Registry owns disposal once a registration is accepted. Must be idempotent. */
  dispose?(signal: AbortSignal): Promise<void>;
}
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
export function validateRegistration(value: unknown): asserts value is ProviderRegistration {
  const r = value as ProviderRegistration;
  if (!r || r.protocolVersion !== 1 || typeof r.id !== 'string' || !identifier.test(r.id)) {
    throw new BionicError('configuration', 'Invalid provider ID or protocol version');
  }
  if (
    !r.provider ||
    ['definitions', 'authorize', 'invoke'].some(
      (method) => typeof (r.provider as any)[method] !== 'function',
    ) ||
    (r.dispose !== undefined && typeof r.dispose !== 'function')
  ) {
    throw new BionicError('configuration', `Invalid provider interface: ${r.id}`);
  }
}

export class ProviderRegistry implements CapabilityProvider {
  private routes = new Map<string, CapabilityProvider>();
  private catalog: Capability[] = [];
  private scopes = new Map<string, Schema>();
  private registrations: ProviderRegistration[] = [];
  private controller = new AbortController();
  private closing?: Promise<void>;
  private state: 'collecting' | 'ready' | 'failed' | 'closed' = 'collecting';
  private ids = new Set<string>();
  private errors: string[] = [];

  offer(value: unknown): { accepted: boolean; error?: string } {
    if (this.state !== 'collecting') {
      return { accepted: false, error: 'Provider registry is not collecting' };
    }
    try {
      validateRegistration(value);
      if (this.ids.has(value.id)) {
        throw new Error('Duplicate provider ID');
      }
      // Take ownership before metadata validation so failed startup also cleans up.
      this.ids.add(value.id);
      this.registrations.push(value);
      const scope = structuredClone(
        value.scopeSchema ?? { type: 'object', additionalProperties: false },
      );
      checkSchema(scope);
      const definitions = structuredClone(value.provider.definitions());
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
      this.scopes.set(value.id, scope);
      for (const definition of definitions) {
        this.routes.set(definition.name, {
          definitions: () => [],
          authorize: value.provider.authorize.bind(value.provider),
          invoke: value.provider.invoke.bind(value.provider),
        });
      }
      this.catalog.push(...definitions);
      return { accepted: true };
    } catch {
      // Configuration exceptions can contain credentials supplied by host SDKs.
      const message = 'Invalid, duplicate, reserved or incompatible provider registration';
      this.errors.push(message);
      return { accepted: false, error: message };
    }
  }
  seal(required: string[] = []) {
    if (this.state !== 'collecting') {
      throw new BionicError('configuration', 'Registry already sealed');
    }
    for (const id of required) {
      if (!this.ids.has(id)) {
        this.errors.push(`Required provider missing: ${id}`);
      }
    }
    this.state = this.errors.length ? 'failed' : 'ready';
    this.assertReady();
  }
  private assertReady() {
    if (this.state !== 'ready') {
      throw new BionicError(
        'configuration',
        this.errors.join('; ') || 'Provider registry unavailable',
      );
    }
  }
  definitions() {
    this.assertReady();
    return structuredClone(this.catalog);
  }
  validateGrant(grant: Grant) {
    this.assertReady();
    for (const [id, schema] of this.scopes) {
      validate(schema, grant.resources?.[id] ?? {});
    }
  }
  authorize(name: string, args: Json, grant: Grant, context?: ProviderContext) {
    this.assertReady();
    this.validateGrant(grant);
    const route = this.routes.get(name);
    if (!route) {
      throw new BionicError('forbidden', 'Unknown provider capability');
    }
    // Trusted providers cannot accidentally change the broker's work grant/arguments.
    try {
      const result = route.authorize(name, structuredClone(args), structuredClone(grant), context);
      if (result) {
        return Promise.resolve(result).catch((error) => {
          throw providerError(error);
        });
      }
    } catch (error) {
      throw providerError(error);
    }
  }
  async invoke(name: string, args: Json, context: ProviderContext) {
    this.assertReady();
    const route = this.routes.get(name);
    if (!route) {
      throw new BionicError('forbidden', 'Unknown provider capability');
    }
    const signal = AbortSignal.any([context.signal, this.controller.signal]);
    try {
      return await abortable(
        () => route.invoke(name, structuredClone(args), { ...context, signal }),
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
        throw new BionicError('provider_error', 'Provider cleanup failed or exceeded 1000ms');
      }
    })();
    return this.closing;
  }
}
