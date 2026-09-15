import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../lib/adapters/sqlite.ts';
import { basic, setup } from './helpers.ts';

for (const mode of ['memory', 'file']) {
  test(`registry contract: ${mode}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bionic-test-'));
    const store = new SqliteStore(mode === 'memory' ? ':memory:' : join(dir, 'registry.sqlite'));
    t.after(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const request = {
      path: 'sre/check.js',
      source: 'export function main() {return 1}',
      contract: basic,
      expectedVersion: null,
      requestId: 'one',
    };
    const a = await store.publish(request);
    assert.deepEqual(await store.publish(request), a);
    await assert.rejects(store.publish({ ...request, source: 'changed' }), { code: 'conflict' });
    const b = await store.publish({
      ...request,
      source: 'export function main(){return 2}',
      expectedVersion: '1',
      requestId: 'two',
    });
    assert.equal(a.ref.scriptId, b.ref.scriptId);
    assert.notEqual(a.ref.contentHash, b.ref.contentHash);
    assert.equal((await store.read('sre/check.js')).ref.revision, '2');
    assert.deepEqual(await store.readRef(a.ref), a);
    await assert.rejects(store.publish({ ...request, expectedVersion: '1', requestId: 'stale' }), {
      code: 'conflict',
    });
    await assert.rejects(store.readRef({ ...a.ref, contentHash: '0'.repeat(64) }), {
      code: 'conflict',
    });
    assert.equal((await store.list()).length, 1);
    if (mode === 'file') {
      const reopened = new SqliteStore(join(dir, 'registry.sqlite'));
      assert.deepEqual(await reopened.readRef(a.ref), a);
      reopened.close();
    }
  });
}
test('two connections enforce stale-write checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bionic-race-')),
    file = join(dir, 'db');
  const a = new SqliteStore(file),
    b = new SqliteStore(file);
  try {
    const request = {
      path: 'a.js',
      source: 'export function main(){return 1}',
      contract: basic,
      expectedVersion: null,
    };
    const results = await Promise.allSettled([
      a.publish({ ...request, requestId: 'a' }),
      b.publish({ ...request, requestId: 'b' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('logical traversal and physical symlinks are rejected', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  for (const path of ['/tmp/a.js', '../a.js', 'sre/../a.js', 'sre//a.js', 'sre\\a.js']) {
    await assert.rejects(s.save(undefined, {}, path), { code: 'invalid_input' });
  }
  const dir = mkdtempSync(join(tmpdir(), 'bionic-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync('/tmp', join(dir, 'link'));
  assert.throws(() => new SqliteStore(join(dir, 'link/db')), { code: 'forbidden' });
});
test('registry scopes apply to browsing, writes, and refs', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const hidden = await s.save(undefined, {}, 'private/a.js');
  await s.save(undefined, {}, 'sre/a.js');
  s.ctx.grant.readPrefixes = ['sre'];
  s.ctx.grant.writePrefixes = ['scratch'];
  assert.equal(((await s.call('ls', {})) as any).items[0].path, 'sre/');
  await assert.rejects(s.run(hidden), { code: 'permission_required' });
  await assert.rejects(s.save(undefined, {}, 'sre/b.js'), { code: 'permission_required' });
});
test('discovery, glob, grep, cursors and edits', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(
    'export function main(){return "latency"}',
    { description: 'diagnose latency' },
    'sre/a.js',
  );
  await s.save(undefined, {}, 'sre/b.js');
  await s.save(undefined, {}, 'scratch/c.js');
  assert.equal(((await s.call('find', { pattern: 'sre/*.js' })) as any).items.length, 2);
  assert.equal(((await s.call('grep', { pattern: 'latency' })) as any).items[0].line, 1);
  const first = (await s.call('find', { pattern: '**', limit: 1 })) as any;
  assert.equal(
    ((await s.call('find', { pattern: '**', limit: 1, cursor: first.nextCursor })) as any).items
      .length,
    1,
  );
  assert.equal(((await s.call('search', { query: 'test' })) as any).items.length, 1);
  const edited = (await s.call('edit', {
    path: a.path,
    baseVersion: '1',
    edits: [{ oldText: 'latency', newText: 'health' }],
  })) as any;
  assert.equal(edited.ref.revision, '2');
  await assert.rejects(s.call('edit', { path: a.path, baseVersion: '1', edits: [] }), {
    code: 'conflict',
  });
  await assert.rejects(s.call('find', { pattern: '**', limit: 1, cursor: first.nextCursor }), {
    code: 'conflict',
  });
});
