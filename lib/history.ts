import { BionicError, type Invocation, type Json } from './contracts.ts';
import type { RunRepository, RunsRequest } from './runs.ts';

/** Shared by Pi, scripts and runtime embeddings; storage never decides caller identity. */
export async function queryHistory(
  repository: RunRepository,
  request: RunsRequest,
  ctx: Invocation,
): Promise<unknown> {
  const access = {
    principals: [...new Set([ctx.grant.principal, ...(ctx.grant.historyPrincipals ?? [])])],
    readPrefixes: ctx.grant.readPrefixes,
  };
  switch (request.action) {
    case 'list':
      return repository.list(request, access);
    case 'get': {
      const run = await repository.get(request.runId, access);
      const calls = await repository.calls(request.runId, access, request.limit, request.cursor);
      return { ...run, calls };
    }
    case 'input':
    case 'output': {
      const { run, info, value } = await repository.payload(request.runId, request.action, access);
      return {
        runId: run.runId,
        ref: run.ref,
        path: run.path,
        startedAt: run.startedAt,
        status: run.status,
        kind: run.kind,
        info,
        ...(value !== undefined ? { [request.action]: select(value, request.pointer ?? '') } : {}),
        ...(request.pointer !== undefined ? { pointer: request.pointer } : {}),
      };
    }
  }
}
function select(value: Json, pointer: string): Json {
  if (pointer === '') {
    return value;
  }
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) {
    throw new BionicError('invalid_input', 'Invalid JSON Pointer');
  }
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key) ||
      (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))
    ) {
      throw new BionicError('not_found', 'Output/input path unavailable');
    }
    value = (value as Record<string, Json>)[key];
  }
  return value;
}
