import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { BionicError } from '../contracts.ts';
import { ProviderRegistry, validateRegistration, type ProviderRegistration } from './registry.ts';
import { abortable } from '../abort.ts';

const DISCOVER = 'bionic:providers:discover:v1';
const PROBE = 'bionic:providers:probe:v1';
interface Request {
  epoch: string;
  offer(value: unknown): { accepted: boolean; error?: string };
}

/** Call synchronously from a Pi extension factory, after any awaited configuration. */
export function registerBionicProvider(pi: ExtensionAPI, registration: ProviderRegistration) {
  validateRegistration(registration);
  let canRegister = true;
  pi.events.emit(PROBE, {
    acknowledge: (state: { canRegister: boolean }) => {
      canRegister = state.canRegister;
    },
  });
  if (!canRegister) {
    throw new BionicError(
      'configuration',
      'Register providers during extension initialization; reload to change providers',
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
    const result = request.offer({ ...registration, dispose });
    accepted = result.accepted;
    error = result.error;
  });
  pi.on('session_start', (_event, ctx) => {
    let present = false;
    pi.events.emit(PROBE, { acknowledge: () => (present = true) });
    if (!present || error) {
      ctx.ui.notify(error ?? `Bionic is missing for provider ${registration.id}`, 'error');
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
export function providerDiscovery(pi: ExtensionAPI) {
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
  return (registry: ProviderRegistry, required: string[]) => {
    canRegister = false;
    let open = true;
    pi.events.emit(DISCOVER, {
      epoch: randomUUID(),
      offer: (value: unknown) =>
        open
          ? registry.offer(value)
          : { accepted: false, error: 'Late registration: reload to change providers' },
    } satisfies Request);
    open = false;
    registry.seal(required);
  };
}
