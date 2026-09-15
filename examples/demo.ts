import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApplication } from '../lib/application.ts';
import { newWork, defaultGrant } from '../lib/policy.ts';
import { FakeSreHost } from '../lib/adapters/fake-sre.ts';
import type { Artifact, Contract } from '../lib/contracts.ts';
const root = mkdtempSync(join(tmpdir(), 'bionic-demo-'));
const app = openApplication(root, new FakeSreHost(), defaultGrant);
const ctx = newWork(undefined, { task: 'Diagnose checkout latency' });
const contract: Contract = {
  description: 'Check fake service health and latency',
  inputSchema: {
    type: 'object',
    properties: { service: { type: 'string' } },
    required: ['service'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  capabilities: [{ name: 'service.get', version: 1 }],
  tools: [],
  fixtures: [],
};
try {
  const saved = (await app.service.invoke(
    'write',
    {
      path: 'sre/diagnose-latency.js',
      source:
        'export async function main(host, input) { return await host.invoke("service.get", { name: input.service }); }',
      contract,
      expectedVersion: null,
    },
    ctx,
    'save',
  )) as unknown as Artifact;
  const run = await app.service.invoke(
    'execute',
    { ref: saved.ref, input: { service: 'checkout' } },
    ctx,
    'run',
  );
  console.log(JSON.stringify({ root, run }, null, 2));
} finally {
  app.store.close();
}
