import { BionicError } from './contracts.ts';

/** Stops waiting even if trusted host code ignores cancellation. Does not undo I/O. */
export function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BionicError('cancelled', 'Operation cancelled'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) {
          throw new BionicError('cancelled', 'Operation cancelled');
        }
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
