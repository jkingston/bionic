import { Ajv, type ValidateFunction } from 'ajv';
import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { BionicError, type Json, type Schema } from './contracts.ts';
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validators = new Map<string, ValidateFunction>();
function compiled(schema: object): ValidateFunction {
  const key = hash(schema);
  let result = validators.get(key);
  if (result) {
    return result;
  }
  result = ajv.compile(schema);
  ajv.removeSchema(schema); // decoded revisions must not grow Ajv's identity cache
  if (validators.size >= 128) {
    validators.delete(validators.keys().next().value!);
  }
  validators.set(key, result);
  return result;
}
export function validate(schema: object, data: unknown): void {
  const queue: [unknown, number][] = [[data, 0]];
  let count = 0;
  while (queue.length) {
    const [value, depth] = queue.pop()!;
    if (++count > 20000 || depth > 48) {
      throw new BionicError('limit', 'JSON structure exceeds limits');
    }
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        queue.push([child, depth + 1]);
      }
    }
  }
  const validator = compiled(schema);
  if (!validator(data)) {
    throw new BionicError('invalid_input', ajv.errorsText(validator.errors));
  }
}
export function checkSchema(schema: Schema): void {
  // Bounded, structural JSON Schema subset: no regex, recursive references or
  // combinators that can consume unbounded host CPU on agent-authored input.
  const allowed = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'description',
    'title',
    '$schema',
  ]);
  let nodes = 0;
  const visit = (v: unknown, depth = 0): void => {
    if (++nodes > 2000 || depth > 24) {
      throw new BionicError('invalid_input', 'Schema too complex');
    }
    if (typeof v === 'boolean') {
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new BionicError('invalid_input', 'Expected a schema object');
    }
    for (const [key, value] of Object.entries(v)) {
      if (!allowed.has(key)) {
        throw new BionicError('invalid_input', `Unsupported schema keyword: ${key}`);
      }
      if (key === 'properties') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new BionicError('invalid_input', 'Invalid schema properties');
        }
        Object.values(value).forEach((child) => visit(child, depth + 1));
      }
      if (key === 'items' || key === 'additionalProperties') {
        visit(value, depth + 1);
      }
      if (key === 'enum' && (!Array.isArray(value) || value.length > 100)) {
        throw new BionicError('invalid_input', 'Enum exceeds 100 choices');
      }
    }
  };
  visit(schema);
  try {
    compiled(schema);
  } catch (e) {
    throw new BionicError('invalid_input', `Invalid schema: ${String(e)}`);
  }
}
export function scriptPath(path: string): string {
  if (path.length > 240 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/.test(path)) {
    throw new BionicError(
      'invalid_input',
      'Expected a relative script path such as sre/diagnose.js',
    );
  }
  return path;
}
export function prefix(path = ''): string {
  if (path === '') {
    return '';
  }
  const clean = path.replace(/\/$/, '');
  if (clean.length > 240 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(clean)) {
    throw new BionicError('invalid_input', 'Invalid logical folder');
  }
  return clean + '/';
}
export function inScope(path: string, scopes: string[]): boolean {
  return scopes.some((s) => path.startsWith(prefix(s)));
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  return (
    '{' +
    Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function sourceValid(source: string): void {
  if (Buffer.byteLength(source) > 128 * 1024) {
    throw new BionicError('limit', 'Script exceeds 128 KiB');
  }
  let tree: any;
  try {
    tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (e) {
    throw new BionicError('invalid_input', String(e));
  }
  let main = false;
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ImportExpression' ||
      (node.source && node.type?.startsWith('Export'))
    ) {
      throw new BionicError('invalid_input', 'Imports are not supported');
    }
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name === 'main'
    ) {
      main = true;
    }
    Object.values(node).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)));
  };
  walk(tree);
  if (!main) {
    throw new BionicError('invalid_input', 'Export function main(host, input)');
  }
}
export function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
