import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createRuntime,
  createClockModule,
  createCatalogModule,
  createHttpJsonModule,
  BionicError,
  type RuntimeModule,
  type RuntimePolicy,
  type CallContext,
  type Artifact,
} from '../lib/runtime/index.ts';
import { basic } from './helpers.ts';

async function setup(t: TestContext, modules: RuntimeModule[], policy?: RuntimePolicy) {
  const root = mkdtempSync(join(tmpdir(), 'bionic-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await createRuntime({ root, modules, policy });
  t.after(() => runtime.dispose());
  const work = runtime.beginWork({ task: 'Runtime without Pi' });
  let index = 0;
  const call = async (name: string, input: unknown = {}) => {
    const artifact = (await work.invoke('write', {
      path: `call-${index++}.js`,
      expectedVersion: null,
      source: `export async function main(host,input){try{return await host.invoke(${JSON.stringify(name)},input)}catch(e){return {error:e.code}}}`,
      contract: { ...basic, capabilities: [{ name, version: 1 }] },
    })) as unknown as Artifact;
    return (await work.invoke('execute', { ref: artifact.ref, input })) as any;
  };
  return { runtime, work, call };
}

test('runtime modules work without Pi or grants; catalogs expose only configured entries', async (t) => {
  const entries = [{ id: 'checkout', description: 'Checkout', data: { environment: 'demo' } }];
  const module = createCatalogModule(entries);
  const s = await setup(t, [createClockModule(), module]);
  entries[0].id = 'tampered';
  assert.deepEqual((await s.call('catalog.list')).output, [
    { id: 'checkout', description: 'Checkout', data: { environment: 'demo' } },
  ]);
  assert.equal((await s.call('catalog.get', { id: 'secret' })).output.error, 'not_found');
  assert.ok(Number.isFinite(Date.parse((await s.call('clock.now')).output.utc)));
  assert.equal(s.runtime.capabilities().length, 3);
});

test('module registration fails atomically on malformed, duplicate and reserved APIs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bionic-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = createClockModule();
  for (const modules of [
    [null],
    [clock, clock],
    [clock, { ...clock, id: 'other' }],
    [{ ...clock, capabilities: [{ ...clock.capabilities[0], name: 'work.current' }] }],
    [{ ...clock, capabilities: [{ ...clock.capabilities[0], inputSchema: { pattern: '.*' } }] }],
  ]) {
    await assert.rejects(createRuntime({ root, modules: modules as RuntimeModule[] }), {
      code: 'configuration',
    });
  }
  const cleaned: number[] = [];
  await assert.rejects(
    createRuntime({
      root,
      modules: [1, 2].map((id) => ({
        ...createClockModule(),
        dispose: async () => {
          cleaned.push(id);
        },
      })),
    }),
  );
  assert.deepEqual(cleaned.sort(), [1, 2]);
});

test('runtime snapshots metadata, owns cleanup, and prevents use after disposal', async (t) => {
  let disposals = 0;
  const clock = {
    ...createClockModule(),
    dispose: async () => {
      disposals++;
    },
  };
  const s = await setup(t, [clock]);
  clock.capabilities[0].name = 'changed';
  const catalog = s.runtime.capabilities();
  catalog[0].name = 'changed-again';
  assert.equal(s.runtime.capabilities()[0].name, 'clock.now');
  await Promise.all([s.runtime.dispose(), s.runtime.dispose()]);
  assert.equal(disposals, 1);
  assert.throws(() => s.runtime.beginWork({}), /closed/);
  await assert.rejects(s.work.invoke('ls', {}), { code: 'cancelled' });
});

test('optional policy narrows capabilities and awaits authorization before module invocation', async (t) => {
  let calls = 0;
  const clock = createClockModule();
  clock.invoke = async () => {
    calls++;
    return {};
  };
  const s = await setup(t, [clock], {
    authorize: async () => {
      await Promise.resolve();
      throw new BionicError('permission_required', 'Policy denied');
    },
  });
  assert.equal((await s.call('clock.now')).output.error, 'permission_required');
  assert.equal(calls, 0);
  const narrowed = await setup(t, [createClockModule()], { capabilities: ['work.current'] });
  await assert.rejects(narrowed.call('clock.now'), { code: 'permission_required' });
  const readOnly = await setup(t, [], { writePrefixes: ['scratch/'] });
  await assert.rejects(
    readOnly.work.invoke('write', {
      path: 'outside.js',
      expectedVersion: null,
      source: 'export function main(){return 1}',
      contract: basic,
    }),
    { code: 'permission_required' },
  );
});

test('module authorization and policy both apply; cancellation bounds uncooperative host calls', async (t) => {
  let received: CallContext | undefined;
  const clock = createClockModule();
  clock.invoke = async (_name, _args, ctx) => {
    received = ctx;
    return new Promise(() => {});
  };
  const s = await setup(t, [clock], { principal: 'headless' });
  const timer = setTimeout(() => s.work.cancel(), 250);
  try {
    assert.equal((await s.call('clock.now')).status, 'cancelled');
    assert.equal(received?.signal.aborted, true);
    assert.equal(received?.principal, 'headless');
    assert.equal(received?.workId, s.work.id);
    assert.ok(!('resources' in received!));
    assert.equal(s.work.usage.active, 0);
  } finally {
    clearTimeout(timer);
  }
  let invoked = false;
  const denied = await setup(
    t,
    [
      {
        ...createClockModule(),
        authorize: async () => {
          throw new BionicError('permission_required', 'Module denied');
        },
        invoke: async () => {
          invoked = true;
          return {};
        },
      },
    ],
    { authorize: () => {} },
  );
  assert.equal((await denied.call('clock.now')).output.error, 'permission_required');
  assert.equal(invoked, false);
});

test('module cleanup is bounded and attempted once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bionic-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const runtime = await createRuntime({
    root,
    modules: [
      {
        ...createClockModule(),
        dispose: async () => {
          calls++;
          return new Promise(() => {});
        },
      },
    ],
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(runtime.dispose(), /cleanup/);
    await assert.rejects(runtime.dispose(), /cleanup/);
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('HTTP module uses configured resources, fixed routes, bounded JSON and cancellation', async (t) => {
  let requests = 0;
  let query = '';
  const server = createServer((req, res) => {
    requests++;
    query = req.url ?? '';
    assert.equal(req.headers.authorization, 'Bearer SECRET_TOKEN');
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { Location: '/ok' }).end();
    } else if (req.url?.startsWith('/large')) {
      res.end(JSON.stringify({ value: 'x'.repeat(4096) }));
    } else if (req.url?.startsWith('/hang')) {
      res.writeHead(200);
      res.write('{');
    } else if (req.url?.startsWith('/error')) {
      res.writeHead(500).end('SECRET_TOKEN');
    } else {
      res.end(JSON.stringify({ value: 'ok' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options = {
    id: 'platform',
    origin,
    allowInsecureHttp: true,
    timeoutMs: 200,
    maxResponseBytes: 1024,
    headers: () => ({ Authorization: 'Bearer SECRET_TOKEN' }),
    operations: ['ok', 'redirect', 'large', 'hang', 'error'].map((path) => ({
      capability: {
        name: `http.${path}`,
        version: 1,
        effect: 'read' as const,
        description: path,
        inputSchema: {
          type: 'object',
          properties: { service: { type: 'string' } },
          required: ['service'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
      path: `/${path}`,
      query: { service: 'service' },
      resource: { argument: 'service', allowed: ['checkout&url=http://evil'] },
    })),
  };
  assert.throws(() => createHttpJsonModule({ ...options, allowInsecureHttp: false }), /HTTPS/);
  assert.throws(
    () =>
      createHttpJsonModule({
        ...options,
        operations: [{ ...options.operations[0], path: '//evil.test' }],
      }),
    /Invalid HTTP/,
  );
  const s = await setup(t, [createHttpJsonModule(options)]);
  assert.equal(
    (await s.call('http.ok', { service: 'denied' })).output.error,
    'permission_required',
  );
  assert.equal(requests, 0);
  const input = { service: 'checkout&url=http://evil' };
  assert.deepEqual((await s.call('http.ok', input)).output, { value: 'ok' });
  assert.equal(new URL(query, origin).searchParams.get('url'), null);
  for (const [name, error] of [
    ['redirect', 'provider_error'],
    ['large', 'limit'],
    ['hang', 'cancelled'],
    ['error', 'provider_error'],
  ]) {
    const before: number = requests;
    const result = await s.call(`http.${name}`, input);
    assert.equal(result.output.error, error);
    assert.ok(!JSON.stringify(result).includes('SECRET_TOKEN'));
    assert.equal(requests, before + 1);
  }
});
