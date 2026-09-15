import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, createFakeSreModule } from '../lib/runtime/index.ts';
import type { Artifact, Contract } from '../lib/contracts.ts';
const root = mkdtempSync(join(tmpdir(), 'bionic-demo-'));
const runtime = await createRuntime({ root, modules: [createFakeSreModule()] });
const work = runtime.beginWork({ task: 'Diagnose checkout latency' });
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
  const saved = (await work.invoke(
    'write',
    {
      path: 'sre/diagnose-latency.js',
      source:
        'export async function main(host, input) { return await host.invoke("service.get", { name: input.service }); }',
      contract,
      expectedVersion: null,
    },
    { requestId: 'save' },
  )) as unknown as Artifact;
  const run = await work.invoke(
    'execute',
    { ref: saved.ref, input: { service: 'checkout' } },
    { requestId: 'run' },
  );
  console.log(JSON.stringify({ root, run }, null, 2));
} finally {
  await runtime.dispose();
}
