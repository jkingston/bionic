// This Node worker hosts QuickJS compiled to WASM. Guest source never runs in V8.
// No WASI, module loader, filesystem, network, process, or native object imports.
import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
let completed = false;
let context, runtime, timer;
const pending = new Map();
let sequence = 0;
const send = (value) => parentPort.postMessage(value);
const fail = (error) => {
  if (completed) {
    return;
  }
  completed = true;
  send({ type: 'error', message: String(error).slice(0, 2000) });
  clearInterval(timer);
};
try {
  const QuickJS = await getQuickJS();
  runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + workerData.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  context = runtime.newContext();
  const pump = () => {
    if (completed) {
      return;
    }
    const result = runtime.executePendingJobs(100);
    if (result.error) {
      const message = context.dump(result.error);
      result.error.dispose();
      fail(JSON.stringify(message));
    }
  };
  const bridge = context.newFunction('__bridge', (kindHandle, nameHandle, jsonHandle) => {
    const kind = context.getString(kindHandle),
      name = context.getString(nameHandle),
      serialized = context.getString(jsonHandle);
    if (
      !['api', 'tool'].includes(kind) ||
      name.length > 100 ||
      serialized.length > 262144 ||
      pending.size >= 32
    ) {
      return context.throwError('Invalid or excessive bridge request');
    }
    let args;
    try {
      args = JSON.parse(serialized);
    } catch {
      return context.throwError('Arguments must be JSON');
    }
    const id = String(++sequence);
    const deferred = context.newPromise();
    pending.set(id, deferred);
    send({ type: 'call', id, kind, name, args });
    return deferred.handle;
  });
  context.setProp(context.global, '__bridge', bridge);
  bridge.dispose();
  const finish = context.newFunction('__finish', (handle) => {
    const serialized = context.getString(handle);
    if (Buffer.byteLength(serialized) > workerData.maxOutputBytes) {
      return context.throwError('Output budget exceeded');
    }
    try {
      const output = JSON.parse(serialized);
      if (!completed) {
        completed = true;
        clearInterval(timer);
        send({ type: 'result', output });
      }
    } catch {
      fail('Result must be JSON serializable');
    }
  });
  context.setProp(context.global, '__finish', finish);
  finish.dispose();
  const reject = context.newFunction('__fail', (handle) => fail(context.getString(handle)));
  context.setProp(context.global, '__fail', reject);
  reject.dispose();
  const setup = context.evalCode(`
    globalThis.host = Object.freeze({
      invoke: (name, args) => __bridge('api', name, JSON.stringify(args)),
      tools: Object.freeze({ invoke: (name, args) => __bridge('tool', name, JSON.stringify(args)) })
    });
  `);
  context.unwrapResult(setup).dispose();
  parentPort.on('message', (response) => {
    if (completed) {
      return;
    }
    const deferred = pending.get(response.id);
    if (!deferred) {
      return;
    }
    pending.delete(response.id);
    try {
      if (response.error) {
        const value = context.newError(response.error.message);
        context
          .newString(response.error.code)
          .consume((code) => context.setProp(value, 'code', code));
        deferred.reject(value);
        value.dispose();
      } else {
        const value = context.unwrapResult(
          context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(response.output))})`),
        );
        deferred.resolve(value);
        value.dispose();
      }
      deferred.dispose();
      pump();
    } catch (e) {
      fail(e);
    }
  });
  const input = JSON.stringify(JSON.stringify(workerData.input));
  const result = context.evalCode(
    `${workerData.source}\n;Promise.resolve(main(host, JSON.parse(${input}))).then(v => __finish(JSON.stringify(v))).catch(e => __fail(String(e)));`,
    'script.mjs',
    { type: 'module' },
  );
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    fail(JSON.stringify(error));
  } else {
    result.value.dispose();
  }
  timer = setInterval(pump, 2);
  pump();
} catch (e) {
  fail(e);
}
