import type { Capability, Grant, Json, ProviderContext, ToolName } from '../contracts.ts';

/** A host capability module. No Pi, model, or UI dependencies. */
export interface RuntimeModule {
  id: string;
  capabilities: Capability[];
  authorize?(name: string, args: Json, context: CallContext): void | Promise<void>;
  invoke(name: string, args: Json, context: CallContext): Promise<Json>;
  dispose?(signal: AbortSignal): Promise<void>;
}
export type CallContext = ProviderContext;
/** Optional restrictions over the authority of explicitly loaded modules. */
export interface RuntimePolicy {
  principal?: string;
  capabilities?: string[];
  tools?: ToolName[];
  readPrefixes?: string[];
  writePrefixes?: string[];
  limits?: Partial<Grant['limits']>;
  authorize?(name: string, args: Json, context: CallContext): void | Promise<void>;
}
