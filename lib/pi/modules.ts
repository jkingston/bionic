import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { BionicError } from '../contracts.ts';
import type { RuntimeModule } from '../runtime/types.ts';
import { validateModule } from '../runtime/registry.ts';
import { abortable } from '../abort.ts';

const DISCOVER = 'bionic:modules:discover:v1';
const PROBE = 'bionic:modules:probe:v1';
interface Request {
  epoch: string;
  offer(value: unknown): { accepted: boolean; error?: string };
}

/** Call synchronously from a Pi extension factory, after any awaited configuration. */
export function registerModule(pi: ExtensionAPI, registration: RuntimeModule) {
  validateModule(registration);
  let canRegister = true;
  pi.events.emit(PROBE, {
    acknowledge: (state: { canRegister: boolean }) => {
      canRegister = state.canRegister;
    },
  });
  if (!canRegister) {
    throw new BionicError(
      'configuration',
      'Register modules during extension initialization; reload to change modules',
    );
  }
  let accepted = false;
  let error: string | undefined;
  let disposed = false;
  const dispose = async (signal: AbortSignal) => {
    if (!disposed) {
      disposed = true;
      await registration.dispose?.(signal);
    }
  };
  pi.events.on(DISCOVER, (value) => {
    const request = value as Request;
    if (!request || typeof request.epoch !== 'string' || typeof request.offer !== 'function') {
      error = 'Malformed Bionic discovery request';
      return;
    }
    const result = request.offer({
      id: registration.id,
      capabilities: registration.capabilities,
      authorize: registration.authorize?.bind(registration),
      invoke: registration.invoke.bind(registration),
      dispose,
    });
    accepted = result.accepted;
    error = result.error;
  });
  pi.on('session_start', (_event, ctx) => {
    let present = false;
    pi.events.emit(PROBE, { acknowledge: () => (present = true) });
    if (!present || error) {
      ctx.ui.notify(error ?? `Bionic is missing for module ${registration.id}`, 'error');
    }
  });
  pi.on('session_shutdown', async () => {
    if (!accepted) {
      // Unclaimed registrations still own resources if factory initialization opened any.
      const signal = AbortSignal.timeout(1000);
      await abortable(() => dispose(signal), signal);
    }
  });
}

/** Installed in the core factory; discovery happens only after all factories finish. */
export function moduleDiscovery(pi: ExtensionAPI) {
  let canRegister = true;
  let consumers = 0;
  pi.events.emit(PROBE, { acknowledge: () => consumers++ });
  if (consumers) {
    throw new BionicError('configuration', 'More than one Bionic core is loaded');
  }
  pi.events.on(PROBE, (value) => {
    const acknowledge = (value as { acknowledge?: unknown })?.acknowledge;
    if (typeof acknowledge === 'function') {
      acknowledge({ canRegister });
    }
  });
  return () => {
    const modules: RuntimeModule[] = [];
    canRegister = false;
    let open = true;
    pi.events.emit(DISCOVER, {
      epoch: randomUUID(),
      offer: (value: unknown) =>
        open
          ? (modules.push(value as RuntimeModule), { accepted: true })
          : { accepted: false, error: 'Late registration: reload to change modules' },
    } satisfies Request);
    open = false;
    return modules;
  };
}
