import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './helpers.ts';
import { createRuntime } from '../lib/runtime/index.ts';
import { SqliteRuns } from '../lib/adapters/sqlite-runs.ts';
import type { RunRecord } from '../lib/runs.ts';
import { browseRuns, inspectRun, runSummary, safeText } from '../lib/pi/history.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const access = { principals: ['local'], readPrefixes: [''] };
function record(runId: string, now: number): Omit<RunRecord, 'inputInfo' | 'outputInfo'> {
  return {
    runId,
    workId: 'work',
    parentRunId: null,
    principal: 'local',
    ref: { registryId: 'registry', scriptId: 'script', revision: '1', contentHash: 'hash' },
    path: 'script.js',
    kind: 'execution',
    status: 'running',
    startedAt: new Date(now).toISOString(),
    deadline: now + 100,
    callCount: 0,
    childCount: 0,
  };
}

test('reference results survive a fresh runtime and scripts can process selected output', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bionic-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setup(undefined, join(root, 'registry.sqlite'));
  const artifact = await s.save(
    'export function main(host,input){return {items:input.items, "a/b":{"~key":null}}}',
  );
  const input = { items: [10, 20] };
  const run = (await s.call('execute', { ref: artifact.ref, input, result: 'reference' })) as any;
  assert.equal(run.outputInfo.state, 'available');
  assert.ok(!Object.hasOwn(run, 'output'));
  const saved = (await s.call('runs', { action: 'input', runId: run.runId })) as any;
  assert.deepEqual(saved.input, input);
  s.store.close();
  const runtime = await createRuntime({ root });
  t.after(() => runtime.dispose());
  const result = (await runtime.history({
    action: 'output',
    runId: run.runId,
    pointer: '/items/1',
  })) as any;
  assert.equal(result.output, 20);
  assert.deepEqual(result.ref, artifact.ref);
  assert.equal(
    ((await runtime.history({ action: 'output', runId: run.runId, pointer: '/a~1b/~0key' })) as any)
      .output,
    null,
  );
  for (const pointer of ['/items/length', '/__proto__', '/items/01', '/missing']) {
    await assert.rejects(runtime.history({ action: 'output', runId: run.runId, pointer }), {
      code: 'not_found',
    });
  }
  await assert.rejects(runtime.history({ action: 'output', runId: run.runId, pointer: '/a~2b' }), {
    code: 'invalid_input',
  });
  const work = runtime.beginWork({ task: 'summarize saved data' });
  const wrapper = (await work.invoke('write', {
    path: 'summarize.js',
    expectedVersion: null,
    source:
      'export async function main(host,input){const r=await host.tools.invoke("runs",{action:"output",runId:input.runId,pointer:"/items"});return r.output.reduce((a,b)=>a+b,0)}',
    contract: { ...artifact.contract, tools: ['runs'] },
  })) as any;
  assert.equal(
    ((await work.invoke('execute', { ref: wrapper.ref, input: { runId: run.runId } })) as any)
      .output,
    30,
  );
});

test('history enforces principal, readable scope, declarations and cumulative output budgets', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const artifact = await s.save('export function main(){return "private"}', {}, 'private/data.js');
  const run = await s.run(artifact);
  s.ctx.grant.principal = 'other';
  assert.deepEqual(((await s.call('runs', { action: 'list' })) as any).items, []);
  for (const action of ['get', 'input', 'output']) {
    await assert.rejects(s.call('runs', { action, runId: run.runId }), { code: 'not_found' });
  }
  s.ctx.grant.historyPrincipals = ['local'];
  assert.equal(
    ((await s.call('runs', { action: 'output', runId: run.runId })) as any).output,
    'private',
  );
  s.ctx.grant.readPrefixes = ['public/'];
  await assert.rejects(s.call('runs', { action: 'get', runId: run.runId }), { code: 'not_found' });
  s.ctx.grant.readPrefixes = [''];
  const denied = await s.save(
    'export async function main(host){return host.tools.invoke("runs",{action:"list"})}',
    {},
    'denied.js',
  );
  assert.equal((await s.run(denied)).status, 'error');
  s.ctx.grant.limits.outputBytes = s.ctx.budget.outputBytes + 1;
  await assert.rejects(s.call('runs', { action: 'output', runId: run.runId }), { code: 'limit' });
});

test('history pages are stable across insertions and filters include children, revisions and fixtures', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const child = await s.save();
  const parent = await s.save(
    `export async function main(host){await host.tools.invoke('execute',{ref:${JSON.stringify(child.ref)},input:{}});return 1}`,
    { tools: ['execute'] },
    'parent.js',
  );
  const first = await s.run(parent);
  const second = await s.run(parent);
  const page = (await s.call('runs', { action: 'list', limit: 1 })) as any;
  assert.equal(page.items[0].runId, second.runId);
  await s.run(parent);
  const next = (await s.call('runs', { action: 'list', limit: 1, cursor: page.nextCursor })) as any;
  assert.equal(next.items[0].runId, first.runId);
  await assert.rejects(
    s.call('runs', { action: 'list', limit: 1, status: 'error', cursor: page.nextCursor }),
    { code: 'invalid_input' },
  );
  const children = (await s.call('runs', { action: 'list', parentRunId: first.runId })) as any;
  assert.equal(children.items.length, 1);
  assert.deepEqual(children.items[0].ref, child.ref);
  const detail = (await s.call('runs', { action: 'get', runId: first.runId })) as any;
  assert.equal(detail.childCount, 1);
  assert.equal(detail.calls.items[0].name, 'execute');
  assert.equal(detail.callCount, 1);
  assert.ok(!('args' in detail.calls.items[0]));
  assert.equal(
    ((await s.call('runs', { action: 'list', ref: child.ref, includeChildren: true })) as any).items
      .length,
    3,
  );
  assert.equal(
    ((await s.call('runs', { action: 'list', workId: s.ctx.workId, path: 'parent.js' })) as any)
      .items.length,
    3,
  );
  assert.equal(
    ((await s.call('runs', { action: 'list', since: '2099-01-01T00:00:00.000Z' })) as any).items
      .length,
    0,
  );
  await assert.rejects(s.call('runs', { action: 'list', since: 'yesterday' }), {
    code: 'invalid_input',
  });
  const fixture = await s.save(
    undefined,
    { fixtures: [{ input: {}, calls: [], expectedOutput: 42 }] },
    'fixture.js',
  );
  await s.call('verify', { ref: fixture.ref });
  assert.equal(
    ((await s.call('runs', { action: 'list', kind: 'fixture' })) as any).items.length,
    1,
  );
  assert.equal(
    ((await s.call('runs', { action: 'list' })) as any).items.some(
      (x: any) => x.kind === 'fixture',
    ),
    false,
  );
  s.ctx.fixture = { calls: [], index: 0 };
  await assert.rejects(s.call('runs', { action: 'list' }), { code: 'forbidden' });
});

test('running records are visible, cancellation finalizes, and rejected requests never appear as executions', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const artifact = await s.save('export function main(){return new Promise(()=>{})}');
  const controller = new AbortController();
  const pending = s.run(artifact, {}, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const running = ((await s.call('runs', { action: 'list', status: 'running' })) as any).items;
  assert.equal(running.length, 1);
  assert.equal(running[0].outputInfo.state, 'pending');
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(
    ((await s.call('runs', { action: 'get', runId: result.runId })) as any).status,
    'cancelled',
  );
  assert.equal(
    ((await s.call('runs', { action: 'output', runId: result.runId })) as any).info.state,
    'absent',
  );
  await assert.rejects(
    s.call('execute', { ref: { ...artifact.ref, revision: '999' }, input: {} }),
    { code: 'not_found' },
  );
  assert.equal(((await s.call('runs', { action: 'list' })) as any).items.length, 1);
});

test('large history payloads require selection and are never silently truncated', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save('export function main(){return {large:"x".repeat(70000),small:42}}');
  const run = (await s.call('execute', { ref: a.ref, input: {}, result: 'reference' })) as any;
  assert.equal(run.status, 'success');
  await assert.rejects(s.call('runs', { action: 'output', runId: run.runId }), { code: 'limit' });
  assert.equal(
    ((await s.call('runs', { action: 'output', runId: run.runId, pointer: '/small' })) as any)
      .output,
    42,
  );
});

test('retention expires payloads and bounds disk records without treating active work as crashed', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  let now = 1000;
  const repo = new SqliteRuns(
    db,
    { ttlMs: 100, maxRuns: 2, maxTotalBytes: 20, maxPayloadBytes: 20 },
    () => now,
  );
  await repo.start(record('one', now), null);
  await repo.finish('one', { status: 'success', output: { value: 1 } });
  await repo.start(record('two', now), {});
  const observer = new SqliteRuns(db, {}, () => now);
  assert.equal((await observer.get('two', access)).status, 'running');
  now += 101;
  assert.equal((await observer.get('two', access)).status, 'unknown');
  assert.equal((await repo.payload('one', 'output', access)).info.state, 'expired');
  assert.equal((await repo.get('one', access)).status, 'success');
  await repo.start(record('three', now), {});
  await assert.rejects(repo.get('one', access), { code: 'not_found' });
  assert.equal((await repo.get('three', access)).status, 'running');
  await repo.finish('three', { status: 'success', output: 'x'.repeat(25) });
  assert.equal((await repo.payload('three', 'output', access)).info.state, 'not_retained');
  const disabled = new SqliteRuns(db, { retainInputs: false, retainOutputs: false }, () => now);
  await disabled.start(record('disabled', now), { secret: true });
  await disabled.finish('disabled', { status: 'success', output: null });
  assert.equal((await disabled.payload('disabled', 'input', access)).info.state, 'not_retained');
  assert.equal((await disabled.payload('disabled', 'output', access)).info.state, 'not_retained');
});

test('payload quota evicts oldest payloads and calls paginate with explicit continuation', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const repo = new SqliteRuns(db, { maxTotalBytes: 10 });
  await repo.start(record('one', Date.now()), null);
  await repo.finish('one', { status: 'success', output: '1234' });
  await repo.start(record('two', Date.now()), null);
  assert.equal((await repo.payload('one', 'input', access)).info.state, 'expired');
  assert.ok((db.prepare('SELECT SUM(bytes) AS n FROM run_payloads').get() as any).n <= 10);
  for (let i = 0; i < 3; i++) {
    await repo.appendCall('two', {
      callId: String(i),
      kind: 'api',
      name: 'test',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      outcome: 'success',
    });
  }
  const first = await repo.calls('two', access, 2);
  assert.equal(first.items.length, 2);
  assert.equal((await repo.calls('two', access, 2, first.nextCursor)).items.length, 1);
});

test('human history navigation uses shared queries and escapes terminal sequences', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const run = await s.run(await s.save());
  const messages: string[] = [];
  const choices = ['Output', 'Children', 'Back', 'Back'];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (text: string) => messages.push(text),
      select: async () => choices.shift(),
      input: async () => '',
    },
  } as unknown as ExtensionContext;
  await inspectRun(ctx, (request) => s.call('runs', request), run.runId);
  assert.ok(messages.some((text) => text.includes('42')));
  assert.match(runSummary(run), /test.js @1/);
  assert.equal(safeText('\u001b[2J'), '\\u001b[2J');
  await browseRuns({ ...ctx, hasUI: false }, (request) => s.call('runs', request));
  assert.ok(messages.at(-1)?.includes(run.runId));
});

test('active run capacity blocks execution and aborted start releases the worker slot', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bionic-history-capacity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await createRuntime({ root, history: { maxRuns: 1 } });
  t.after(() => runtime.dispose());
  const work = runtime.beginWork(null);
  const a = (await work.invoke('write', {
    path: 'wait.js',
    source: 'export function main(){return new Promise(()=>{})}',
    expectedVersion: null,
    contract: {
      description: 'wait',
      inputSchema: {},
      outputSchema: {},
      tools: [],
      capabilities: [],
      fixtures: [],
    },
  })) as any;
  const abort = new AbortController();
  const first = work.invoke('execute', { ref: a.ref, input: {} }, { signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(work.invoke('execute', { ref: a.ref, input: {} }), { code: 'limit' });
  assert.equal(work.usage.active, 1);
  abort.abort();
  await first;
  assert.equal(work.usage.active, 0);
  assert.equal(((await runtime.history({ action: 'list' })) as any).items.length, 1);
});
