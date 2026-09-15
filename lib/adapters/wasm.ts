import { Worker } from 'node:worker_threads';
import {
  BionicError,
  failure,
  type ExecutionBackend,
  type ExecutionRequest,
  type Json,
} from '../contracts.ts';
export class WasmExecutor implements ExecutionBackend {
  async execute(
    request: ExecutionRequest,
    broker: (kind: 'tool' | 'api', name: string, args: Json, callId: string) => Promise<Json>,
    signal?: AbortSignal,
  ): Promise<Json> {
    if (signal?.aborted) {
      throw new BionicError('cancelled', 'Execution cancelled');
    }
    const worker = new Worker(new URL('../worker.mjs', import.meta.url), {
      workerData: request,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, output?: Json) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void worker.terminate().then(() => (error ? reject(error) : resolve(output!)));
      };
      const abort = () => finish(new BionicError('cancelled', 'Execution cancelled'));
      const timer = setTimeout(
        () => finish(new BionicError('timeout', 'Execution deadline exceeded')),
        request.timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('error', (error) => finish(new BionicError('runtime_error', error.message)));
      worker.on('exit', (code) => {
        if (!settled) {
          finish(new BionicError('runtime_error', `WASM worker exited (${code})`));
        }
      });
      worker.on('message', async (message) => {
        if (settled) {
          return;
        }
        if (message.type === 'result') {
          return finish(undefined, message.output);
        }
        if (message.type === 'error') {
          return finish(new BionicError('runtime_error', message.message));
        }
        if (message.type === 'call') {
          try {
            const output = await broker(message.kind, message.name, message.args, message.id);
            if (!settled) {
              worker.postMessage({ id: message.id, output });
            }
          } catch (e) {
            if (!settled) {
              worker.postMessage({ id: message.id, error: failure(e) });
            }
          }
        }
      });
    });
  }
}
