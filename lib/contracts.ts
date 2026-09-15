export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = Record<string, unknown>;
export const TOOL_NAMES = [
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
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export interface ScriptRef {
  registryId: string;
  scriptId: string;
  revision: string;
  contentHash: string;
}
export interface Fixture {
  input: Json;
  calls: { name: string; args: Json; output: Json }[];
  expectedOutput: Json;
}
export interface Contract {
  description: string;
  inputSchema: Schema;
  outputSchema: Schema;
  capabilities: { name: string; version: number }[];
  tools: ToolName[];
  fixtures: Fixture[];
}
export interface Artifact {
  ref: ScriptRef;
  path: string;
  source: string;
  contract: Contract;
  createdAt: string;
}
export interface Summary {
  path: string;
  ref: ScriptRef;
  description: string;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface PublishRequest {
  path: string;
  source: string;
  contract: Contract;
  expectedVersion: string | null;
  requestId: string;
}
export interface ScriptRepository {
  readonly registryId: string;
  read(path: string, revision?: string): Promise<Artifact>;
  readRef(ref: ScriptRef): Promise<Artifact>;
  list(): Promise<Summary[]>;
  publish(request: PublishRequest): Promise<Artifact>;
  close(): void;
}
export interface Evidence {
  id: string;
  kind: 'run' | 'verification' | 'tool';
  at: string;
  workId: string;
  data: Json;
}
export interface EvidenceRepository {
  append(evidence: Evidence): Promise<void>;
  recent(limit: number): Promise<Evidence[]>;
}
export interface Capability {
  name: string;
  version: number;
  description: string;
  inputSchema: Schema;
  outputSchema: Schema;
  effect: 'read';
}
export interface CapabilityProvider {
  definitions(): Capability[];
  authorize(name: string, args: Json, grant: Grant): void;
  invoke(name: string, args: Json): Promise<Json>;
}
export interface Grant {
  principal: string;
  readPrefixes: string[];
  writePrefixes: string[];
  tools: ToolName[];
  capabilities: string[];
  services: string[];
  limits: {
    calls: number;
    writes: number;
    sourceBytes: number;
    outputBytes: number;
    workMs: number;
    runMs: number;
    depth: number;
    workers: number;
  };
}
export interface Budget {
  calls: number;
  writes: number;
  sourceBytes: number;
  outputBytes: number;
  active: number;
  deadline: number;
}
export interface Invocation {
  workId: string;
  grant: Grant;
  budget: Budget;
  depth: number;
  tools: Set<string>;
  capabilities: Set<string>;
  parentRunId?: string;
  fixture?: { calls: Fixture['calls']; index: number };
  workInput: Json;
}
export interface ExecutionRequest {
  source: string;
  input: Json;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface ExecutionBackend {
  execute(
    request: ExecutionRequest,
    broker: (kind: 'tool' | 'api', name: string, args: Json, callId: string) => Promise<Json>,
    signal?: AbortSignal,
  ): Promise<Json>;
}
export interface ToolService {
  invoke(
    name: string,
    args: unknown,
    context: Invocation,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Json>;
}
export class BionicError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BionicError';
  }
}
export function failure(e: unknown): { code: string; message: string } {
  return e instanceof BionicError
    ? { code: e.code, message: e.message }
    : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}
