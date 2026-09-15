import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  ProviderRegistry,
  createClockProvider,
  createCatalogProvider,
  createHttpJsonProvider,
  type ProviderRegistration,
  type ProviderContext,
} from '../lib/providers/index.ts';
import { defaultGrant, newWork } from '../lib/policy.ts';
import { SqliteStore } from '../lib/adapters/sqlite.ts';
import { WasmExecutor } from '../lib/adapters/wasm.ts';
import { BionicService } from '../lib/service.ts';
import { basic } from './helpers.ts';
import type { Artifact } from '../lib/contracts.ts';

const context = (resources = {}): ProviderContext => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 5000,
  principal: 'test',
  workId: 'work',
  runId: 'run',
  callId: 'call',
  resources,
  maxOutputBytes: 1024,
});
function registry(...providers: ProviderRegistration[]) {
  const result = new ProviderRegistry();
  for (const provider of providers) {
    assert.equal(result.offer(provider).accepted, true);
  }
  result.seal(providers.map((p) => p.id));
  return result;
}

test('provider registry fails atomically on malformed/duplicate/reserved/incompatible definitions', async () => {
  for (const broken of [
    null,
    { ...createClockProvider(), protocolVersion: 2 },
    {
      ...createClockProvider(),
      provider: {
        ...createClockProvider().provider,
        definitions: () => [
          { ...createClockProvider().provider.definitions()[0], name: 'work.current' },
        ],
      },
    },
    {
      ...createClockProvider(),
      provider: {
        ...createClockProvider().provider,
        definitions: () => [
          { ...createClockProvider().provider.definitions()[0], inputSchema: { pattern: '.*' } },
        ],
      },
    },
  ]) {
    const r = new ProviderRegistry();
    assert.equal(r.offer(broken).accepted, false);
    assert.throws(() => r.seal(), /registration/);
    assert.throws(() => r.definitions(), /registration/);
    await r.dispose();
  }
  for (const duplicate of [
    createClockProvider(),
    { ...createClockProvider(), id: 'another.clock' },
  ]) {
    const r = new ProviderRegistry();
    r.offer(createClockProvider());
    assert.equal(r.offer(duplicate).accepted, false);
    assert.throws(() => r.seal(), /registration/);
    await r.dispose();
  }
  const r = new ProviderRegistry();
  assert.throws(() => r.seal(['missing']), /Required provider missing/);
  await r.dispose();
});

test('provider metadata is snapshotted; late offers rejected; disposed registry cannot invoke', async () => {
  let disposed = 0;
  const p = createClockProvider();
  const r = registry({
    ...p,
    dispose: async () => {
      disposed++;
    },
  });
  const definitions = r.definitions();
  definitions[0].name = 'changed';
  p.provider.definitions = () => [];
  assert.equal(r.definitions()[0].name, 'clock.now');
  assert.equal(r.offer(createClockProvider()).accepted, false);
  await Promise.all([r.dispose(), r.dispose()]);
  assert.equal(disposed, 1);
  await assert.rejects(r.invoke('clock.now', {}, context()), /unavailable/);
});

test('catalog scopes are validated and only granted entries are discoverable', async () => {
  const r = registry(
    createCatalogProvider([
      { id: 'public', description: 'Allowed', data: { host: 'demo' } },
      { id: 'secret', description: 'Other', data: { host: 'hidden' } },
    ]),
  );
  const grant = defaultGrant();
  grant.resources = { 'bionic.catalog': { entries: ['public'] } };
  r.validateGrant(grant);
  assert.throws(() => r.authorize('catalog.get', { id: 'secret' }, grant), /not granted/);
  assert.deepEqual(await r.invoke('catalog.list', {}, context(grant.resources)), [
    { id: 'public', description: 'Allowed', data: { host: 'demo' } },
  ]);
  assert.deepEqual(await r.invoke('catalog.list', {}, context()), []);
  grant.resources = { 'bionic.catalog': { entries: 'all' } };
  assert.throws(() => r.validateGrant(grant));
  await r.dispose();
});

test('broker passes host context and terminates a WASM call whose provider ignores abort', async () => {
  const clock = createClockProvider();
  let received: ProviderContext | undefined;
  clock.provider.invoke = async (_name, _args, ctx) => {
    received = ctx;
    return new Promise(() => {});
  };
  const r = registry(clock);
  const store = new SqliteStore(':memory:');
  try {
    const service = new BionicService(store, store, new WasmExecutor(), r);
    const grant = defaultGrant();
    grant.capabilities.push('clock.now');
    const work = newWork(grant);
    const a = (await service.invoke(
      'write',
      {
        path: 'hang.js',
        expectedVersion: null,
        source: 'export async function main(host){return host.invoke("clock.now",{})}',
        contract: { ...basic, capabilities: [{ name: 'clock.now', version: 1 }] },
      },
      work,
      'save',
    )) as unknown as Artifact;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 250);
    try {
      const result = (await service.invoke(
        'execute',
        { ref: a.ref, input: {} },
        work,
        'run',
        abort.signal,
      )) as any;
      assert.equal(result.status, 'cancelled');
      assert.equal(received?.signal.aborted, true);
      assert.equal(received?.workId, work.workId);
      assert.equal(received?.principal, grant.principal);
      assert.ok(received?.callId.startsWith(received.runId));
      assert.equal(work.budget.active, 0);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    store.close();
    await r.dispose();
  }
});

test('async authorization finishes before invocation and cannot bypass denial', async () => {
  let calls = 0;
  const clock = createClockProvider();
  clock.provider.authorize = async () => {
    await Promise.resolve();
    const { BionicError } = await import('../lib/contracts.ts');
    throw new BionicError('permission_required', 'Denied asynchronously');
  };
  clock.provider.invoke = async () => {
    calls++;
    return {};
  };
  const r = registry(clock);
  const store = new SqliteStore(':memory:');
  try {
    const service = new BionicService(store, store, new WasmExecutor(), r);
    const grant = defaultGrant();
    grant.capabilities.push('clock.now');
    const work = newWork(grant);
    const a = (await service.invoke(
      'write',
      {
        path: 'denied.js',
        expectedVersion: null,
        source:
          'export async function main(host){try{return await host.invoke("clock.now",{})}catch(e){return {denied:e.code}}}',
        contract: { ...basic, capabilities: [{ name: 'clock.now', version: 1 }] },
      },
      work,
      'save',
    )) as unknown as Artifact;
    const result = (await service.invoke('execute', { ref: a.ref, input: {} }, work, 'run')) as any;
    assert.equal(result.output.denied, 'permission_required');
    assert.equal(calls, 0);
  } finally {
    store.close();
    await r.dispose();
  }
});

test('cleanup is bounded even when a provider ignores its shutdown signal', async () => {
  let calls = 0;
  const r = registry({
    ...createClockProvider(),
    dispose: async () => {
      calls++;
      return new Promise(() => {});
    },
  });
  // Keep the loop alive while AbortSignal.timeout (which is unrefed) is exercised.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(r.dispose(), /cleanup failed or exceeded/);
    await assert.rejects(r.dispose(), /cleanup failed or exceeded/);
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('HTTP JSON enforces fixed routes, resources, redirects, response bounds and cancellation', async (t) => {
  let requests = 0;
  let authorized = false;
  let query = '';
  const server = createServer((req, res) => {
    requests++;
    authorized = req.headers.authorization === 'Bearer SECRET_TOKEN';
    query = req.url ?? '';
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { Location: '/ok' }).end();
    } else if (req.url?.startsWith('/large')) {
      res.end(JSON.stringify({ value: 'x'.repeat(4096) }));
    } else if (req.url?.startsWith('/hang')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
  const capability = {
    name: 'platform.health',
    version: 1,
    effect: 'read' as const,
    description: 'Health',
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
  };
  const make = (path: string) =>
    createHttpJsonProvider({
      id: 'platform',
      origin,
      allowInsecureHttp: true,
      headers: () => ({ Authorization: 'Bearer SECRET_TOKEN' }),
      timeoutMs: 500,
      operations: [
        {
          capability,
          path,
          query: { service: 'service' },
          resource: { argument: 'service', scope: 'services' },
        },
      ],
    });
  assert.throws(() => createHttpJsonProvider({ id: 'bad', origin, operations: [] }), /HTTPS/);
  assert.throws(() => make('//example.com/escape'), /Invalid HTTP/);
  const grant = defaultGrant();
  grant.resources = { platform: { services: ['checkout&url=http://evil'] } };
  const args = { service: 'checkout&url=http://evil' };
  const good = registry(make('/ok'));
  assert.throws(() => good.authorize(capability.name, { service: 'denied' }, grant), /not granted/);
  assert.equal(requests, 0);
  good.authorize(capability.name, args, grant);
  assert.deepEqual(await good.invoke(capability.name, args, context(grant.resources)), {
    value: 'ok',
  });
  assert.equal(authorized, true);
  assert.equal(new URL(query, origin).searchParams.get('url'), null);
  assert.equal(new URL(query, origin).searchParams.get('service'), args.service);
  await good.dispose();
  for (const [path, code] of [
    ['/redirect', 'provider_error'],
    ['/large', 'limit'],
    ['/error', 'provider_error'],
    ['/hang', 'cancelled'],
  ]) {
    const r = registry(make(path));
    const before: number = requests;
    await assert.rejects(
      r.invoke(capability.name, args, context(grant.resources)),
      (error: any) => {
        assert.equal(error.code, code);
        assert.ok(!error.message.includes('SECRET_TOKEN'));
        return true;
      },
    );
    assert.equal(requests, before + 1);
    await r.dispose();
  }
  const cancelled = registry(make('/hang'));
  const controller = new AbortController();
  const call = cancelled.invoke(capability.name, args, {
    ...context(grant.resources),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(call, { code: 'cancelled' });
  await cancelled.dispose();
});
