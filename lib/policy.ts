import { randomUUID } from 'node:crypto';
import { BionicError, TOOL_NAMES, type Grant, type Invocation, type Json } from './contracts.ts';
import { prefix, validate } from './validation.ts';
export function coreGrant(): Grant {
  return { ...defaultGrant(), capabilities: ['work.current', 'policy.describe'], services: [] };
}
export function defaultGrant(): Grant {
  return {
    principal: 'local',
    readPrefixes: [''],
    writePrefixes: [''],
    tools: [...TOOL_NAMES],
    capabilities: [
      'service.get',
      'service.dependencies',
      'metrics.query',
      'logs.search',
      'deployments.list',
      'work.current',
      'policy.describe',
    ],
    services: ['checkout', 'payments', 'auth'],
    limits: {
      calls: 200,
      writes: 30,
      sourceBytes: 1024 * 1024,
      outputBytes: 2 * 1024 * 1024,
      workMs: 120000,
      runMs: 10000,
      depth: 8,
      workers: 12,
    },
  };
}
export function validateGrant(grant: Grant): Grant {
  if (!grant || typeof grant.principal !== 'string' || !grant.principal) {
    throw new BionicError('invalid_input', 'Invalid grant principal');
  }
  for (const key of [
    'readPrefixes',
    'writePrefixes',
    'tools',
    'capabilities',
    'services',
  ] as const) {
    if (!Array.isArray(grant[key]) || !grant[key].every((x) => typeof x === 'string')) {
      throw new BionicError('invalid_input', `Invalid grant ${key}`);
    }
  }
  grant.readPrefixes.forEach(prefix);
  grant.writePrefixes.forEach(prefix);
  if (grant.resources !== undefined) {
    if (
      !grant.resources ||
      typeof grant.resources !== 'object' ||
      Array.isArray(grant.resources) ||
      Buffer.byteLength(JSON.stringify(grant.resources)) > 65536
    ) {
      throw new BionicError('invalid_input', 'Invalid provider resource scopes');
    }
    validate({ type: 'object' }, grant.resources);
  }
  if (grant.tools.some((t) => !TOOL_NAMES.includes(t))) {
    throw new BionicError('invalid_input', 'Unknown granted tool');
  }
  for (const key of Object.keys(defaultGrant().limits) as (keyof Grant['limits'])[]) {
    if (!Number.isSafeInteger(grant.limits?.[key]) || grant.limits[key] < 1) {
      throw new BionicError('invalid_input', `Invalid limit ${key}`);
    }
  }
  return structuredClone(grant);
}
export function newWork(grant = defaultGrant(), input: Json = null): Invocation {
  grant = validateGrant(grant);
  return {
    workId: randomUUID(),
    grant,
    workInput: input,
    budget: {
      calls: 0,
      writes: 0,
      sourceBytes: 0,
      outputBytes: 0,
      active: 0,
      deadline: Date.now() + grant.limits.workMs,
    },
    depth: 0,
    tools: new Set(grant.tools),
    capabilities: new Set(grant.capabilities),
  };
}
export function check(ctx: Invocation, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new BionicError('cancelled', 'Work cancelled');
  }
  if (Date.now() >= ctx.budget.deadline) {
    throw new BionicError('limit', 'Work deadline exhausted');
  }
}
export function charge(
  ctx: Invocation,
  key: 'calls' | 'writes' | 'sourceBytes' | 'outputBytes',
  amount: number,
) {
  ctx.budget[key] += amount;
  if (ctx.budget[key] > ctx.grant.limits[key]) {
    throw new BionicError('limit', `Work ${key} budget exhausted`);
  }
}
