import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BionicError, type Grant } from './contracts.ts';
import { coreGrant, defaultGrant, validateGrant } from './policy.ts';

export interface Deployment {
  extensions: string[];
  requiredProviders: string[];
  grant: Grant;
}
export function readDeployment(path: string): Deployment {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !value ||
    !Array.isArray(value.extensions) ||
    !value.extensions.every((v: unknown) => typeof v === 'string' && v.length > 0) ||
    !Array.isArray(value.requiredProviders) ||
    !value.requiredProviders.every(
      (v: unknown) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(v),
    )
  ) {
    throw new BionicError(
      'configuration',
      'Deployment requires extensions and requiredProviders arrays',
    );
  }
  return {
    extensions: value.extensions.map((file: string) => resolve(dirname(path), file)),
    requiredProviders: value.requiredProviders,
    grant: value.grant ? validateGrant(value.grant) : coreGrant(),
  };
}
export function deploymentPolicy(): { requiredProviders: string[]; grant: Grant } {
  if (process.env.BIONIC_DEPLOYMENT) {
    return readDeployment(process.env.BIONIC_DEPLOYMENT);
  }
  if (process.env.BIONIC_DEMO === '1') {
    const grant = defaultGrant();
    grant.capabilities.push('clock.now', 'catalog.list', 'catalog.get');
    grant.resources = { 'bionic.catalog': { entries: ['checkout', 'payments', 'auth'] } };
    return { requiredProviders: ['bionic.fake-sre', 'bionic.clock', 'bionic.catalog'], grant };
  }
  return { requiredProviders: [], grant: coreGrant() };
}
