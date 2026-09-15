import type { Json, Page, ScriptRef } from './contracts.ts';

export type RunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'timeout' | 'unknown';
export interface PayloadInfo {
  state: 'pending' | 'available' | 'not_retained' | 'expired' | 'absent';
  bytes: number;
  expiresAt?: string;
}
export interface RunRecord {
  runId: string;
  workId: string;
  parentRunId: string | null;
  principal: string;
  ref: ScriptRef;
  path: string;
  kind: 'execution' | 'fixture';
  status: RunStatus;
  callCount: number;
  childCount: number;
  startedAt: string;
  deadline: number;
  finishedAt?: string;
  durationMs?: number;
  error?: { code: string; message: string };
  inputInfo: PayloadInfo;
  outputInfo: PayloadInfo;
}
export interface RunCall {
  callId: string;
  kind: 'tool' | 'api';
  name: string;
  startedAt: string;
  durationMs: number;
  outcome: 'success' | 'error';
  error?: { code: string; message: string };
}
export interface RunAccess {
  principals: string[];
  readPrefixes: string[];
}
export interface RunQuery {
  path?: string;
  ref?: ScriptRef;
  workId?: string;
  parentRunId?: string;
  includeChildren?: boolean;
  kind?: 'execution' | 'fixture' | 'all';
  status?: RunStatus;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}
export type RunsRequest =
  | ({ action: 'list' } & RunQuery)
  | { action: 'get'; runId: string; limit?: number; cursor?: string }
  | { action: 'input' | 'output'; runId: string; pointer?: string };
export interface HistoryOptions {
  retainInputs?: boolean;
  retainOutputs?: boolean;
  /** Payload TTL; metadata remains until maxRuns is reached. */
  ttlMs?: number;
  maxPayloadBytes?: number;
  maxTotalBytes?: number;
  maxRuns?: number;
}
export interface RunRepository {
  start(record: Omit<RunRecord, 'inputInfo' | 'outputInfo'>, input: Json): Promise<RunRecord>;
  finish(
    runId: string,
    result: {
      status: Exclude<RunStatus, 'running' | 'unknown'>;
      error?: RunRecord['error'];
      output?: Json;
    },
  ): Promise<RunRecord>;
  appendCall(runId: string, call: RunCall): Promise<void>;
  list(query: RunQuery, access: RunAccess): Promise<Page<RunRecord>>;
  get(runId: string, access: RunAccess): Promise<RunRecord>;
  calls(runId: string, access: RunAccess, limit?: number, cursor?: string): Promise<Page<RunCall>>;
  payload(
    runId: string,
    kind: 'input' | 'output',
    access: RunAccess,
  ): Promise<{ run: RunRecord; info: PayloadInfo; value?: Json }>;
}
