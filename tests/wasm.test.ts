import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { defaultGrant } from '../lib/policy.ts';

test('untested code executes and no host globals are exposed', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(
    'export function main(){ return [typeof process,typeof require,typeof fetch,typeof WebAssembly,typeof std,typeof os]; }',
  );
  const result = await s.run(a);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.output, Array(6).fill('undefined'));
});
test('constructor escape stays inside the guest', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(
    'export function main(){return ({}).constructor.constructor("return typeof process")();}',
  );
  assert.equal((await s.run(a)).output, 'undefined');
});
test('imports and arbitrary source execution through tool API rejected', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  await assert.rejects(s.save('import fs from "node:fs"; export function main(){}'), {
    code: 'invalid_input',
  });
  await assert.rejects(s.save('export function main(){return import("node:fs")}'), {
    code: 'invalid_input',
  });
  await assert.rejects(s.call('execute', { source: 'return 1', input: {} }), {
    code: 'invalid_input',
  });
  await assert.rejects(s.call('bash', { command: 'id' }), { code: 'permission_required' });
});
test('infinite loop terminates and the next run works', async (t) => {
  const g = defaultGrant();
  g.limits.runMs = 250;
  const s = setup(g);
  t.after(() => s.store.close());
  const a = await s.save('export function main(){while(true){}}');
  assert.notEqual((await s.run(a)).status, 'success');
  assert.equal(s.ctx.budget.active, 0);
  const b = await s.save(undefined, {}, 'ok.js');
  assert.equal((await s.run(b)).output, 42);
});
test('allocation and output limits contain guest code', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const memory = await s.save(
    'export function main(){const a=[]; while(true) a.push(new Array(100000).fill("hello"));}',
  );
  assert.equal((await s.run(memory)).status, 'error');
  const output = await s.save('export function main(){return "x".repeat(300000)}', {}, 'output.js');
  assert.notEqual((await s.run(output)).status, 'success');
});
test('cancellation interrupts guest computation', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save('export function main(){while(true){}}');
  const controller = new AbortController();
  const run = s.run(a, {}, controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.equal((await run).status, 'cancelled');
  assert.equal(s.ctx.budget.active, 0);
});
test('unresolved guest promises have a deadline', async (t) => {
  const g = defaultGrant();
  g.limits.runMs = 250;
  const s = setup(g);
  t.after(() => s.store.close());
  const a = await s.save('export async function main(){await new Promise(()=>{});}');
  assert.equal((await s.run(a)).status, 'timeout');
});
