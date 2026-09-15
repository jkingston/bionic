import { BionicError, type Json } from '../contracts.ts';
import { FakeSreHost } from '../adapters/fake-sre.ts';
import { defaultGrant } from '../policy.ts';
import type { RuntimeModule } from './types.ts';

const empty = { type: 'object', additionalProperties: false };
export function createClockModule(): RuntimeModule {
  return {
    id: 'bionic.clock',
    capabilities: [
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
    invoke: async () => ({ utc: new Date().toISOString() }),
  };
}
export interface CatalogEntry {
  id: string;
  description: string;
  data: Json;
}
/** Only configured entries exist in this environment; no ambient filesystem reads. */
export function createCatalogModule(entries: CatalogEntry[]): RuntimeModule {
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
  return {
    id: 'bionic.catalog',
    capabilities: [
      {
        name: 'catalog.list',
        version: 1,
        effect: 'read',
        description: 'List configured deployment entries.',
        inputSchema: empty,
        outputSchema: { type: 'array', items: entry },
      },
      {
        name: 'catalog.get',
        version: 1,
        effect: 'read',
        description: 'Get a configured deployment entry.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        outputSchema: entry,
      },
    ],
    async invoke(name, args) {
      if (name === 'catalog.list') {
        return structuredClone(snapshot) as unknown as Json;
      }
      const result = snapshot.find((e) => e.id === (args as { id: string }).id);
      if (!result) {
        throw new BionicError('not_found', 'Catalog entry unavailable');
      }
      return structuredClone(result) as unknown as Json;
    },
  };
}
export function createFakeSreModule(services = ['checkout', 'payments', 'auth']): RuntimeModule {
  const backend = new FakeSreHost();
  const scope = { ...defaultGrant(), services: [...services] };
  return {
    id: 'bionic.fake-sre',
    capabilities: backend.definitions(),
    authorize: (name, args) => backend.authorize(name, args, scope),
    invoke: (name, args) => backend.invoke(name, args),
  };
}
