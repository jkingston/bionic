import { BionicError, type Capability, type Json } from '../contracts.ts';
import type { RuntimeModule } from './types.ts';
import { abortable } from '../abort.ts';
import { validate } from '../validation.ts';

export interface HttpJsonOperation {
  capability: Capability;
  /** Fixed deployment-selected path. Scripts cannot choose URL/path/headers. */
  path: string;
  /** URL query parameter -> input property. Encoded using URLSearchParams. */
  query?: Record<string, string>;
  /** Deployment-owned resource allowlist; no separate grant configuration. */
  resource?: { argument: string; allowed: string[] };
}
export interface HttpJsonOptions {
  id: string;
  origin: string;
  allowInsecureHttp?: boolean;
  operations: HttpJsonOperation[];
  /** Credentials stay in trusted code; this function is called after authorization. */
  headers?: () => Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export function createHttpJsonModule(options: HttpJsonOptions): RuntimeModule {
  const origin = new URL(options.origin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && options.allowInsecureHttp))
  ) {
    throw new BionicError(
      'configuration',
      'HTTP module requires a fixed HTTPS origin (or explicit insecure HTTP)',
    );
  }
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBytes = options.maxResponseBytes ?? 262144;
  if (![timeoutMs, maxBytes].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 2147483647)) {
    throw new BionicError('configuration', 'Invalid HTTP limits');
  }
  const operations = new Map<string, HttpJsonOperation>();
  for (const operation of structuredClone(options.operations)) {
    const url = new URL(operation.path, origin);
    if (
      !operation.path.startsWith('/') ||
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      operation.capability.effect !== 'read' ||
      operations.has(operation.capability.name)
    ) {
      throw new BionicError('configuration', 'Invalid HTTP operation or duplicate name');
    }
    operations.set(operation.capability.name, operation);
  }
  return {
    id: options.id,
    capabilities: [...operations.values()].map((op) => structuredClone(op.capability)),
    authorize(name, args) {
      const resource = operations.get(name)?.resource;
      if (resource) {
        const allowed = resource.allowed;
        const target = (args as Record<string, Json>)[resource.argument];
        if (!Array.isArray(allowed) || typeof target !== 'string' || !allowed.includes(target)) {
          throw new BionicError('permission_required', 'HTTP resource not granted');
        }
      }
    },
    async invoke(name, args, context) {
      const operation = operations.get(name);
      if (!operation) {
        throw new BionicError('forbidden', 'Unknown HTTP operation');
      }
      const url = new URL(operation.path, origin);
      for (const [parameter, property] of Object.entries(operation.query ?? {})) {
        const value = (args as Record<string, Json>)[property];
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          throw new BionicError('invalid_input', 'HTTP query values must be scalars');
        }
        url.searchParams.set(parameter, String(value));
      }
      const cancel = new AbortController();
      const signal = AbortSignal.any([
        context.signal,
        cancel.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      try {
        return await abortable(async () => {
          const response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json', ...options.headers?.() },
            redirect: 'error',
            signal,
          });
          if (!response.ok || !response.body) {
            throw new BionicError('provider_error', 'HTTP API returned an unsuccessful response');
          }
          const limit = Math.min(maxBytes, context.maxOutputBytes);
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                break;
              }
              size += value.byteLength;
              if (size > limit) {
                throw new BionicError('limit', 'HTTP response exceeds byte limit');
              }
              chunks.push(value);
            }
          } finally {
            void reader.cancel().catch(() => {});
          }
          const output = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
          validate(operation.capability.outputSchema, output);
          return output;
        }, signal);
      } catch (error) {
        if (
          error instanceof BionicError &&
          ['cancelled', 'limit', 'permission_required'].includes(error.code)
        ) {
          throw error;
        }
        // Never return response bodies, URLs, headers or native client errors to scripts.
        throw new BionicError('provider_error', 'HTTP JSON API failed');
      } finally {
        cancel.abort();
      }
    },
  };
}
