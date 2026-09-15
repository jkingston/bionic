import { SqliteStore } from '../lib/adapters/sqlite.ts';
import { FakeSreHost } from '../lib/adapters/fake-sre.ts';
import { WasmExecutor } from '../lib/adapters/wasm.ts';
import { BionicService } from '../lib/service.ts';
import { newWork, defaultGrant } from '../lib/policy.ts';
import type { Artifact, Contract, Grant, Json } from '../lib/contracts.ts';
export const basic: Contract = {
  description: 'A test procedure',
  inputSchema: {},
  outputSchema: {},
  capabilities: [],
  tools: [],
  fixtures: [],
};
export function setup(grant: Grant = defaultGrant(), file = ':memory:') {
  const store = new SqliteStore(file),
    provider = new FakeSreHost();
  const service = new BionicService(store, store, new WasmExecutor(), provider);
  const ctx = newWork(grant);
  let n = 0;
  const call = (name: string, args: unknown, signal?: AbortSignal) =>
    service.invoke(name, args, ctx, `test-${++n}`, signal);
  const save = async (
    source = 'export function main() { return 42; }',
    contract: Partial<Contract> = {},
    path = 'test.js',
  ): Promise<Artifact> =>
    (await call('write', {
      path,
      source,
      contract: { ...basic, ...contract },
      expectedVersion: null,
    })) as unknown as Artifact;
  const run = async (a: Artifact, input: Json = {}, signal?: AbortSignal): Promise<any> =>
    call('execute', { ref: a.ref, input }, signal);
  return { store, provider, service, ctx, call, save, run };
}
