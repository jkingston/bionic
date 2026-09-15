import { randomUUID } from 'node:crypto';
import {
  BionicError,
  TOOL_NAMES,
  failure,
  type CapabilityProvider,
  type Contract,
  type EvidenceRepository,
  type ExecutionBackend,
  type Invocation,
  type Json,
  type ScriptRef,
  type ScriptRepository,
  type ToolName,
  type ToolService,
} from './contracts.ts';
import { schemas, descriptions } from './schemas.ts';
import {
  canonical,
  checkSchema,
  hash,
  inScope,
  json,
  prefix,
  scriptPath,
  sourceValid,
  validate,
} from './validation.ts';
import { charge, check } from './policy.ts';
import { abortable } from './abort.ts';

export class BionicService implements ToolService {
  constructor(
    readonly repository: ScriptRepository,
    readonly evidence: EvidenceRepository,
    readonly executor: ExecutionBackend,
    readonly provider: CapabilityProvider,
  ) {}
  private scope(path: string, ctx: Invocation, write = false) {
    if (!inScope(path, write ? ctx.grant.writePrefixes : ctx.grant.readPrefixes)) {
      throw new BionicError(
        'permission_required',
        `${write ? 'Write' : 'Read'} scope does not include ${path}`,
      );
    }
  }
  private validateContract(source: string, contract: Contract) {
    sourceValid(source);
    checkSchema(contract.inputSchema);
    checkSchema(contract.outputSchema);
    if (new Set(contract.capabilities.map((c) => c.name)).size !== contract.capabilities.length) {
      throw new BionicError('invalid_input', 'Duplicate capabilities');
    }
  }
  async invoke(
    name: string,
    input: unknown,
    ctx: Invocation,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Json> {
    check(ctx, signal);
    charge(ctx, 'calls', 1);
    if (
      !TOOL_NAMES.includes(name as ToolName) ||
      !ctx.tools.has(name) ||
      !ctx.grant.tools.includes(name as ToolName)
    ) {
      throw new BionicError('permission_required', `Tool not granted: ${name}`);
    }
    const tool = name as ToolName;
    if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) {
      throw new BionicError('limit', 'Tool input exceeds 256 KiB');
    }
    validate(schemas[tool], input);
    const args = input as any;
    let result: unknown;
    switch (tool) {
      case 'capabilities':
        result = {
          tools: TOOL_NAMES.filter((t) => ctx.tools.has(t) && ctx.grant.tools.includes(t)).map(
            (name) => ({ name, description: descriptions[name], parameters: schemas[name] }),
          ),
          apis: this.definitions().filter(
            (d) => ctx.capabilities.has(d.name) && ctx.grant.capabilities.includes(d.name),
          ),
          scope: {
            readPrefixes: ctx.grant.readPrefixes,
            writePrefixes: ctx.grant.writePrefixes,
            services: ctx.grant.services,
            resources: ctx.grant.resources ?? {},
          },
          limits: ctx.grant.limits,
          remaining: {
            calls: ctx.grant.limits.calls - ctx.budget.calls,
            writes: ctx.grant.limits.writes - ctx.budget.writes,
            milliseconds: Math.max(0, ctx.budget.deadline - Date.now()),
          },
        };
        break;
      case 'read':
        this.scope(scriptPath(args.path), ctx);
        result = await this.repository.read(args.path, args.revision);
        break;
      case 'write': {
        this.scope(scriptPath(args.path), ctx, true);
        if (ctx.fixture) {
          throw new BionicError('forbidden', 'Verification cannot mutate the registry');
        }
        this.validateContract(args.source, args.contract);
        charge(ctx, 'writes', 1);
        charge(ctx, 'sourceBytes', Buffer.byteLength(args.source));
        result = await this.repository.publish({
          ...args,
          requestId: `${ctx.grant.principal}:${ctx.workId}:${requestId}`,
        });
        break;
      }
      case 'edit': {
        this.scope(scriptPath(args.path), ctx);
        this.scope(args.path, ctx, true);
        if (ctx.fixture) {
          throw new BionicError('forbidden', 'Verification cannot mutate the registry');
        }
        const artifact = await this.repository.read(args.path, args.baseVersion);
        let source = artifact.source;
        for (const edit of args.edits) {
          const pos = source.indexOf(edit.oldText);
          if (pos < 0 || source.indexOf(edit.oldText, pos + 1) >= 0) {
            throw new BionicError('conflict', 'Each edit must match exactly once');
          }
          source = source.slice(0, pos) + edit.newText + source.slice(pos + edit.oldText.length);
        }
        const contract = args.contract ?? artifact.contract;
        this.validateContract(source, contract);
        charge(ctx, 'writes', 1);
        charge(ctx, 'sourceBytes', Buffer.byteLength(source));
        result = await this.repository.publish({
          path: args.path,
          source,
          contract,
          expectedVersion: args.baseVersion,
          requestId: `${ctx.grant.principal}:${ctx.workId}:${requestId}`,
        });
        break;
      }
      case 'ls':
      case 'find':
      case 'grep':
      case 'search':
        result = await this.discover(tool, args, ctx);
        break;
      case 'execute':
        result = await this.run(args.ref, args.input, ctx, signal);
        break;
      case 'verify': {
        const artifact = await this.repository.readRef(args.ref);
        this.scope(artifact.path, ctx);
        const fixtures = artifact.contract.fixtures;
        const outcomes = [];
        for (const fixture of fixtures) {
          const state = { calls: fixture.calls, index: 0 };
          const run = await this.run(args.ref, fixture.input, { ...ctx, fixture: state }, signal);
          outcomes.push({
            passed:
              run.status === 'success' &&
              canonical(run.output) === canonical(fixture.expectedOutput) &&
              state.index === fixture.calls.length,
            runId: run.runId,
            status: run.status,
          });
        }
        result = {
          ref: args.ref,
          status:
            fixtures.length === 0
              ? 'untested'
              : outcomes.every((o) => o.passed)
                ? 'passed'
                : 'failed',
          fixtures: outcomes,
        };
        await this.evidence.append({
          id: randomUUID(),
          kind: 'verification',
          at: new Date().toISOString(),
          workId: ctx.workId,
          data: json({
            ...(result as any),
            runtime: 'quickjs-wasm-0.32.0',
            capabilities: artifact.contract.capabilities,
          }),
        });
        break;
      }
    }
    const output = json(result);
    charge(ctx, 'outputBytes', Buffer.byteLength(JSON.stringify(output)));
    return output;
  }
  private async discover(tool: string, args: any, ctx: Invocation) {
    const folder = prefix(args.path);
    let items: any[] = (await this.repository.list()).filter(
      (a) => a.path.startsWith(folder) && inScope(a.path, ctx.grant.readPrefixes),
    );
    if (tool === 'ls') {
      const entries = new Map<string, any>();
      for (const item of items) {
        const rest = item.path.slice(folder.length),
          slash = rest.indexOf('/');
        if (slash < 0) {
          entries.set(item.path, { ...item, kind: 'script' });
        } else {
          const path = folder + rest.slice(0, slash + 1);
          entries.set(path, { path, kind: 'folder' });
        }
      }
      items = [...entries.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
    }
    if (tool === 'find') {
      let pattern = '^';
      for (let i = 0; i < args.pattern.length; i++) {
        const c = args.pattern[i];
        if (c === '*' && args.pattern[i + 1] === '*') {
          pattern += '.*';
          i++;
        } else if (c === '*') {
          pattern += '[^/]*';
        } else if (c === '?') {
          pattern += '[^/]';
        } else {
          pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
      }
      const regex = new RegExp(pattern + '$');
      items = items.filter((a) => regex.test(a.path));
    }
    if (tool === 'search') {
      const tokens: string[] = [
        ...new Set<string>(
          args.query
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
        ),
      ];
      items = items
        .filter((a) => args.path !== undefined || !a.path.startsWith('scratch/'))
        .map((a) => ({
          ...a,
          score: tokens.reduce(
            (score, token) =>
              score +
              (a.path.toLowerCase().includes(token) ? 3 : 0) +
              (a.description.toLowerCase().includes(token) ? 1 : 0),
            0,
          ),
        }))
        .filter((a) => a.score > 0)
        .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
    }
    if (tool === 'grep') {
      const matches = [];
      for (const a of items) {
        const artifact = await this.repository.readRef(a.ref);
        const lines = artifact.source.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(args.pattern)) {
            matches.push({ path: a.path, ref: a.ref, line: i + 1, text: lines[i].slice(0, 1000) });
          }
        }
      }
      items = matches;
    }
    const signature = hash({ tool, args: { ...args, cursor: undefined }, items });
    let offset = 0;
    if (args.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
        if (
          cursor.signature !== signature ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        ) {
          throw new Error();
        }
        offset = cursor.offset;
      } catch {
        throw new BionicError('conflict', 'Invalid or stale cursor; restart listing');
      }
    }
    const limit = args.limit ?? 20;
    return {
      items: items.slice(offset, offset + limit),
      ...(offset + limit < items.length
        ? {
            nextCursor: Buffer.from(JSON.stringify({ signature, offset: offset + limit })).toString(
              'base64url',
            ),
          }
        : {}),
    };
  }
  private definitions() {
    const obj = { type: 'object', additionalProperties: false, properties: {} };
    return [
      ...this.provider.definitions(),
      {
        name: 'work.current',
        version: 1,
        description: 'Read current trusted work envelope; no user-supplied work ID.',
        effect: 'read',
        inputSchema: obj,
        outputSchema: { type: 'object' },
      },
      {
        name: 'policy.describe',
        version: 1,
        description: 'Read current limits and scope. This is not a grant.',
        effect: 'read',
        inputSchema: obj,
        outputSchema: { type: 'object' },
      },
    ];
  }
  private async api(
    name: string,
    args: Json,
    ctx: Invocation,
    callId: string,
    signal?: AbortSignal,
  ): Promise<Json> {
    check(ctx, signal);
    charge(ctx, 'calls', 1);
    if (!ctx.capabilities.has(name) || !ctx.grant.capabilities.includes(name)) {
      throw new BionicError('permission_required', `API not granted or declared: ${name}`);
    }
    const definition = this.definitions().find((d) => d.name === name);
    if (!definition) {
      throw new BionicError('forbidden', `Unknown API: ${name}`);
    }
    validate(definition.inputSchema, args);
    const deadline = Math.min(ctx.budget.deadline, Date.now() + ctx.grant.limits.runMs);
    const deadlineSignal = AbortSignal.timeout(
      Math.max(1, Math.min(2147483647, deadline - Date.now())),
    );
    const apiSignal = AbortSignal.any([deadlineSignal, ...(signal ? [signal] : [])]);
    const apiContext = {
      signal: apiSignal,
      deadline,
      principal: ctx.grant.principal,
      workId: ctx.workId,
      runId: ctx.parentRunId!,
      callId,
      resources: structuredClone(ctx.grant.resources ?? {}),
      maxOutputBytes: Math.max(0, ctx.grant.limits.outputBytes - ctx.budget.outputBytes),
    };
    if (name !== 'work.current' && name !== 'policy.describe') {
      await abortable(
        () =>
          Promise.resolve(
            this.provider.authorize(name, structuredClone(args), structuredClone(ctx.grant), {
              ...apiContext,
              resources: structuredClone(apiContext.resources),
            }),
          ),
        apiSignal,
      );
    }
    let output: Json;
    if (ctx.fixture) {
      const expected = ctx.fixture.calls[ctx.fixture.index];
      if (!expected || expected.name !== name || canonical(expected.args) !== canonical(args)) {
        throw new BionicError('fixture_mismatch', `Unexpected fixture call ${name}`);
      }
      ctx.fixture.index++;
      output = expected.output;
    } else if (name === 'work.current') {
      output = { workId: ctx.workId, input: ctx.workInput };
    } else if (name === 'policy.describe') {
      output = json({
        principal: ctx.grant.principal,
        services: ctx.grant.services,
        resources: ctx.grant.resources ?? {},
        readPrefixes: ctx.grant.readPrefixes,
        writePrefixes: ctx.grant.writePrefixes,
        limits: ctx.grant.limits,
      });
    } else {
      output = await abortable(() => this.provider.invoke(name, args, apiContext), apiSignal);
    }
    check(ctx, signal);
    validate(definition.outputSchema, output);
    charge(ctx, 'outputBytes', Buffer.byteLength(JSON.stringify(output)));
    return output;
  }
  private async run(
    ref: ScriptRef,
    input: Json,
    ctx: Invocation,
    signal?: AbortSignal,
  ): Promise<any> {
    check(ctx, signal);
    const artifact = await this.repository.readRef(ref);
    this.scope(artifact.path, ctx);
    validate(artifact.contract.inputSchema, input);
    if (ctx.depth >= ctx.grant.limits.depth) {
      throw new BionicError('limit', 'Nesting limit reached');
    }
    if (ctx.budget.active >= ctx.grant.limits.workers) {
      throw new BionicError('limit', 'Concurrent worker limit reached');
    }
    for (const c of artifact.contract.capabilities) {
      if (!ctx.capabilities.has(c.name) || !ctx.grant.capabilities.includes(c.name)) {
        throw new BionicError(
          'permission_required',
          `Script requests ungranted capability ${c.name}`,
        );
      }
      if (!this.definitions().some((d) => d.name === c.name && d.version === c.version)) {
        throw new BionicError(
          'incompatible',
          `Capability version unavailable: ${c.name}@${c.version}`,
        );
      }
    }
    if (artifact.contract.tools.some((t) => !ctx.tools.has(t))) {
      throw new BionicError('permission_required', 'Script requests ungranted tools');
    }
    const runId = randomUUID(),
      start = Date.now();
    const local = new AbortController();
    const abort = () => local.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const child: Invocation = {
      ...ctx,
      depth: ctx.depth + 1,
      parentRunId: runId,
      tools: new Set(artifact.contract.tools),
      capabilities: new Set(artifact.contract.capabilities.map((c) => c.name)),
    };
    ctx.budget.active++;
    const pending = new Set<Promise<Json>>();
    let result: any;
    try {
      const output = await this.executor.execute(
        {
          source: artifact.source,
          input,
          timeoutMs: Math.max(
            1,
            Math.min(ctx.grant.limits.runMs, ctx.budget.deadline - Date.now()),
          ),
          maxOutputBytes: Math.min(
            262144,
            Math.max(0, ctx.grant.limits.outputBytes - ctx.budget.outputBytes),
          ),
        },
        (kind, name, args, callId) => {
          const operation = (async () => {
            try {
              const value =
                kind === 'tool'
                  ? await this.invoke(name, args, child, `${runId}:${callId}`, local.signal)
                  : await this.api(name, args, child, `${runId}:${callId}`, local.signal);
              await this.evidence.append({
                id: `${runId}:${callId}`,
                kind: 'tool',
                at: new Date().toISOString(),
                workId: ctx.workId,
                data: json({ runId, kind, name, outcome: 'success' }),
              });
              return value;
            } catch (e) {
              await this.evidence.append({
                id: `${runId}:${callId}`,
                kind: 'tool',
                at: new Date().toISOString(),
                workId: ctx.workId,
                data: json({ runId, kind, name, outcome: 'error', error: failure(e) }),
              });
              throw e;
            }
          })();
          pending.add(operation);
          void operation.finally(() => pending.delete(operation)).catch(() => {});
          return operation;
        },
        local.signal,
      );
      validate(artifact.contract.outputSchema, output);
      result = { status: 'success', output };
    } catch (e) {
      const error = failure(e);
      result = {
        status: ['cancelled', 'timeout'].includes(error.code) ? error.code : 'error',
        error,
      };
    } finally {
      local.abort();
      await Promise.allSettled([...pending]);
      ctx.budget.active--;
      signal?.removeEventListener('abort', abort);
    }
    const summary = {
      runId,
      parentRunId: ctx.parentRunId ?? null,
      ref,
      status: result.status,
      durationMs: Date.now() - start,
      ...(result.error ? { error: result.error } : {}),
    };
    await this.evidence.append({
      id: runId,
      kind: 'run',
      at: new Date().toISOString(),
      workId: ctx.workId,
      data: json(summary),
    });
    return { ...summary, ...result };
  }
}
