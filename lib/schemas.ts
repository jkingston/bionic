import { Type } from 'typebox';
const object = (properties: any) => Type.Object(properties, { additionalProperties: false });
const text = () => Type.String({ maxLength: 131072 });
const schema = () => Type.Record(Type.String(), Type.Unknown());
const ref = object({
  registryId: Type.String(),
  scriptId: Type.String(),
  revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
});
const optionalFolder = Type.Optional(Type.String({ maxLength: 240 }));
const paging = {
  path: optionalFolder,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
};
export const contractSchema = object({
  description: Type.String({ maxLength: 2000 }),
  inputSchema: schema(),
  outputSchema: schema(),
  capabilities: Type.Array(
    object({ name: Type.String({ maxLength: 100 }), version: Type.Integer({ minimum: 1 }) }),
    { maxItems: 32 },
  ),
  tools: Type.Array(
    Type.Union(
      [
        'read',
        'write',
        'edit',
        'ls',
        'find',
        'grep',
        'search',
        'verify',
        'execute',
        'capabilities',
      ].map((x) => Type.Literal(x)),
    ),
    { maxItems: 10 },
  ),
  fixtures: Type.Array(
    object({
      input: Type.Unknown(),
      calls: Type.Array(
        object({ name: Type.String(), args: Type.Unknown(), output: Type.Unknown() }),
        { maxItems: 100 },
      ),
      expectedOutput: Type.Unknown(),
    }),
    { maxItems: 20 },
  ),
});
export const schemas = {
  read: object({
    path: text(),
    revision: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  }),
  write: object({
    path: text(),
    source: text(),
    contract: contractSchema,
    expectedVersion: Type.Union([Type.String({ pattern: '^[1-9][0-9]*$' }), Type.Null()]),
  }),
  edit: object({
    path: text(),
    baseVersion: Type.String({ pattern: '^[1-9][0-9]*$' }),
    edits: Type.Array(object({ oldText: Type.String({ minLength: 1 }), newText: text() }), {
      maxItems: 50,
    }),
    contract: Type.Optional(contractSchema),
  }),
  ls: object(paging),
  find: object({ ...paging, pattern: Type.String({ maxLength: 240 }) }),
  grep: object({ ...paging, pattern: Type.String({ minLength: 1, maxLength: 500 }) }),
  search: object({ ...paging, query: Type.String({ minLength: 1, maxLength: 500 }) }),
  execute: object({ ref, input: Type.Unknown() }),
  verify: object({ ref }),
  capabilities: object({}),
};
export const descriptions: Record<keyof typeof schemas, string> = {
  read: 'Read a script and contract by logical path. Returns an immutable ref for execution.',
  write:
    'Save script source and contract. expectedVersion=null creates; otherwise compare and append. Drafts can execute without tests.',
  edit: 'Edit a saved script, requiring baseVersion and exactly one match per replacement. Returns a new immutable ref.',
  ls: 'List immediate logical script folders and scripts; never host files.',
  find: 'Find script paths. Glob * matches within one segment, ** spans segments, ? matches one non-slash character.',
  grep: 'Search literal case-sensitive text in current script source. Returns bounded line matches.',
  search:
    'Search scripts by purpose using path and description. Scratch scripts are omitted unless path is supplied.',
  execute:
    'Execute a saved immutable script ref with JSON input in WASM. No inline code or shell. Untested drafts may run within grants.',
  verify:
    'Run saved script fixtures with fake responses. Quality evidence never grants permissions or gates ordinary execution.',
  capabilities:
    'Discover permitted tool and environment API schemas, versions, and current limits. Scripts call host.tools.invoke or host.invoke.',
};
