import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, basic } from './helpers.ts';
import { defaultGrant } from '../lib/policy.ts';

test('fake API calls validate contracts and resource grants', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(
    'export async function main(host,i){return host.invoke("service.get",{name:i.service})}',
    { capabilities: [{ name: 'service.get', version: 1 }] },
  );
  assert.equal((await s.run(a, { service: 'checkout' })).output.latency_ms, 2400);
  s.ctx.grant.services = ['payments'];
  const denied = await s.run(a, { service: 'checkout' });
  assert.equal(denied.status, 'error');
  assert.match(denied.error.message, /not granted/);
});
test('undeclared capabilities fail and review does not grant authority', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(
    'export async function main(host){return host.invoke("service.get",{name:"checkout"})}',
  );
  assert.equal((await s.run(a)).status, 'error');
  const b = await s.save(
    'export function main(){return 1}',
    { capabilities: [{ name: 'production.rollback', version: 1 }] },
    'b.js',
  );
  await assert.rejects(s.run(b), { code: 'permission_required' });
});
test('fixture failure does not prevent ordinary execution', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(undefined, { fixtures: [{ input: {}, calls: [], expectedOutput: 0 }] });
  assert.equal(((await s.call('verify', { ref: a.ref })) as any).status, 'failed');
  assert.equal((await s.run(a)).output, 42);
});
test('verification uses fake responses and checks exact calls', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const response = {
    name: 'checkout',
    status: 'fixture',
    latency_ms: 1,
    error_rate: 0,
    version: 'v1',
    region: 'test',
  };
  const a = await s.save(
    'export async function main(host){return host.invoke("service.get",{name:"checkout"})}',
    {
      capabilities: [{ name: 'service.get', version: 1 }],
      fixtures: [
        {
          input: {},
          calls: [{ name: 'service.get', args: { name: 'checkout' }, output: response }],
          expectedOutput: response,
        },
      ],
    },
  );
  assert.equal(((await s.call('verify', { ref: a.ref })) as any).status, 'passed');
  assert.equal((await s.run(a)).output.status, 'degraded');
});
test('script chains search, read and child execution without an LLM', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  await s.save(
    'export async function main(host,i){return host.invoke("service.get",{name:i.service})}',
    { description: 'health diagnosis', capabilities: [{ name: 'service.get', version: 1 }] },
    'sre/health.js',
  );
  const batch = await s.save(
    `export async function main(host){
  const found=await host.tools.invoke('search',{query:'health'});
  const script=await host.tools.invoke('read',{path:found.items[0].path});
  const results=[];
  for(const service of ['checkout','payments']) results.push(await host.tools.invoke('execute',{ref:script.ref,input:{service}}));
  return results;
 }`,
    { tools: ['search', 'read', 'execute'], capabilities: [{ name: 'service.get', version: 1 }] },
    'scratch/batch.js',
  );
  const run = await s.run(batch);
  assert.equal(run.status, 'success');
  assert.deepEqual(
    run.output.map((r: any) => r.output.name),
    ['checkout', 'payments'],
  );
  const records = await s.store.recent(30);
  assert.equal(records.filter((r) => r.kind === 'run').length, 3);
});
test('script can write, edit, verify and run a child using returned refs', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const source = `export async function main(host){
  const saved=await host.tools.invoke('write',{path:'scratch/child.js',source:'export function main(){return 1}',contract:${JSON.stringify(basic)},expectedVersion:null});
  const edited=await host.tools.invoke('edit',{path:saved.path,baseVersion:saved.ref.revision,edits:[{oldText:'return 1',newText:'return 2'}]});
  const quality=await host.tools.invoke('verify',{ref:edited.ref});
  const run=await host.tools.invoke('execute',{ref:edited.ref,input:{}});
  return {quality:quality.status,output:run.output};
 }`;
  const a = await s.save(source, { tools: ['write', 'edit', 'verify', 'execute'] });
  assert.deepEqual((await s.run(a)).output, { quality: 'untested', output: 2 });
});
test('self-edit does not mutate running revision', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(
    `export async function main(host){await host.tools.invoke('edit',{path:'test.js',baseVersion:'1',edits:[{oldText:'return '+String(17),newText:'return 18'}]});return 17}`,
    { tools: ['edit'] },
  );
  assert.equal((await s.run(a)).output, 17);
  assert.equal((await s.store.read('test.js')).ref.revision, '2');
  assert.equal((await s.store.readRef(a.ref)).ref.revision, '1');
});
test('nested writes cannot bypass scope or fixture constraints', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  const a = await s.save(
    `export async function main(host){return host.tools.invoke('write',{path:'private/child.js',source:'export function main(){return 0}',contract:${JSON.stringify(basic)},expectedVersion:null})}`,
    { tools: ['write'], fixtures: [{ input: {}, calls: [], expectedOutput: 0 }] },
  );
  s.ctx.grant.writePrefixes = ['scratch'];
  assert.equal((await s.run(a)).status, 'error');
  assert.equal(((await s.call('verify', { ref: a.ref })) as any).status, 'failed');
  await assert.rejects(s.store.read('private/child.js'), { code: 'not_found' });
});
test('nested calls share budget even when guest catches failures', async (t) => {
  const g = defaultGrant();
  g.limits.calls = 6;
  const s = setup(g);
  t.after(() => s.store.close());
  const a = await s.save(
    `export async function main(host){let errors=0;for(let i=0;i<10;i++){try{await host.tools.invoke('ls',{})}catch(e){errors++}}return errors}`,
    { tools: ['ls'] },
  );
  const run = await s.run(a);
  assert.ok(run.output >= 6);
  await assert.rejects(s.call('ls', {}), { code: 'limit' });
});
test('nested child deadlines cancel all workers', async (t) => {
  const g = defaultGrant();
  g.limits.runMs = 500;
  const s = setup(g);
  t.after(() => s.store.close());
  const child = await s.save('export function main(){while(true){}}', {}, 'child.js');
  const parent = await s.save(
    `export async function main(host){return host.tools.invoke('execute',{ref:${JSON.stringify(child.ref)},input:{}})}`,
    { tools: ['execute'] },
    'parent.js',
  );
  const controller = new AbortController();
  const promise = s.run(parent, {}, controller.signal);
  setTimeout(() => controller.abort(), 200);
  assert.equal((await promise).status, 'cancelled');
  assert.equal(s.ctx.budget.active, 0);
});
test('untrusted regex schemas are rejected outside the runtime', async (t) => {
  const s = setup();
  t.after(() => s.store.close());
  await assert.rejects(s.save(undefined, { inputSchema: { type: 'string', pattern: '(a+)+$' } }), {
    code: 'invalid_input',
  });
});
test('recursion and fan-out remain bounded without scheduler deadlocks', async (t) => {
  const g = defaultGrant();
  g.limits.depth = 3;
  g.limits.workers = 4;
  const s = setup(g);
  t.after(() => s.store.close());
  const recursive = await s.save(
    'export async function main(host,input){return host.tools.invoke("execute",{ref:input.ref,input})}',
    { tools: ['execute'] },
  );
  const result = await s.run(recursive, { ref: recursive.ref } as any);
  assert.equal(s.ctx.budget.active, 0);
  assert.ok(JSON.stringify(result).includes('Nesting limit'));
  const slow = await s.save(
    'export async function main(){await new Promise(()=>{})}',
    {},
    'slow.js',
  );
  const batch = await s.save(
    `export async function main(host){return Promise.all(Array.from({length:10},()=>host.tools.invoke('execute',{ref:${JSON.stringify(slow.ref)},input:{}})))}`,
    { tools: ['execute'] },
    'fanout.js',
  );
  assert.equal((await s.run(batch)).status, 'error');
  assert.equal(s.ctx.budget.active, 0);
});
