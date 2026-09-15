import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { SqliteStore } from './adapters/sqlite.ts';
import { WasmExecutor } from './adapters/wasm.ts';
import { BionicService } from './service.ts';
import { coreGrant, validateGrant } from './policy.ts';
import { type Grant, BionicError, type Contract, type CapabilityProvider } from './contracts.ts';
export const contextContract: Contract = {
  description: 'Retrieve current work input through the work.current API.',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object' },
  capabilities: [{ name: 'work.current', version: 1 }],
  tools: [],
  fixtures: [],
};
export function openApplication(
  root: string,
  provider: CapabilityProvider,
  fallbackGrant: () => Grant = coreGrant,
) {
  const store = new SqliteStore(join(root, 'registry.sqlite'));
  const service = new BionicService(store, store, new WasmExecutor(), provider);
  const grantFile = join(root, 'grant.json');
  function readGrant(): Grant {
    return existsSync(grantFile)
      ? validateGrant(JSON.parse(readFileSync(grantFile, 'utf8')))
      : validateGrant(fallbackGrant());
  }
  return {
    store,
    service,
    readGrant,
    async seed() {
      try {
        await store.read('system/current-work.js');
      } catch (e) {
        if (!(e instanceof BionicError) || e.code !== 'not_found') {
          throw e;
        }
        try {
          await store.publish({
            path: 'system/current-work.js',
            source:
              'export async function main(host, input) { return await host.invoke("work.current", {}); }',
            contract: contextContract,
            expectedVersion: null,
            requestId: 'bootstrap-current-work-v1',
          });
        } catch (e) {
          if (!(e instanceof BionicError) || e.code !== 'conflict') {
            throw e;
          }
        }
      }
    },
  };
}
