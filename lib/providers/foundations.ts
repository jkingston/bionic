import { BionicError, type Json } from '../contracts.ts';
import type { ProviderRegistration } from './registry.ts';
const empty = { type: 'object', additionalProperties: false };
export function createClockProvider(): ProviderRegistration {
  return {
    protocolVersion: 1,
    id: 'bionic.clock',
    provider: {
      definitions: () => [
        {
          name: 'clock.now',
          version: 1,
          effect: 'read',
          description: 'Read current UTC time.',
          inputSchema: empty,
          outputSchema: {
            type: 'object',
            properties: { utc: { type: 'string' } },
            required: ['utc'],
            additionalProperties: false,
          },
        },
      ],
      authorize() {},
      invoke: async () => ({ utc: new Date().toISOString() }),
    },
  };
}
export interface CatalogEntry {
  id: string;
  description: string;
  data: Json;
}
export function createCatalogProvider(
  entries: CatalogEntry[],
  id = 'bionic.catalog',
): ProviderRegistration {
  const snapshot = structuredClone(entries);
  if (new Set(entries.map((e) => e.id)).size !== entries.length) {
    throw new BionicError('configuration', 'Duplicate catalog entry');
  }
  const entry = {
    type: 'object',
    properties: { id: { type: 'string' }, description: { type: 'string' }, data: {} },
    required: ['id', 'description', 'data'],
    additionalProperties: false,
  };
  function allowed(resources: Record<string, Json>) {
    const scope = resources[id] as { entries?: string[] } | undefined;
    return new Set(scope?.entries ?? []);
  }
  return {
    protocolVersion: 1,
    id,
    scopeSchema: {
      type: 'object',
      properties: { entries: { type: 'array', items: { type: 'string' }, maxItems: 1000 } },
      additionalProperties: false,
    },
    provider: {
      definitions: () => [
        {
          name: 'catalog.list',
          version: 1,
          effect: 'read',
          description: 'List authorized deployment catalog entries.',
          inputSchema: empty,
          outputSchema: { type: 'array', items: entry },
        },
        {
          name: 'catalog.get',
          version: 1,
          effect: 'read',
          description: 'Get an authorized deployment catalog entry.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
          outputSchema: entry,
        },
      ],
      authorize(name, args, grant) {
        if (
          name === 'catalog.get' &&
          !allowed(grant.resources ?? {}).has((args as { id: string }).id)
        ) {
          throw new BionicError('permission_required', 'Catalog entry not granted');
        }
      },
      async invoke(name, args, context) {
        const visible = snapshot.filter((e) => allowed(context.resources).has(e.id));
        if (name === 'catalog.list') {
          return structuredClone(visible) as unknown as Json;
        }
        const result = visible.find((e) => e.id === (args as { id: string }).id);
        if (!result) {
          throw new BionicError('not_found', 'Catalog entry unavailable');
        }
        return structuredClone(result) as unknown as Json;
      },
    },
  };
}
