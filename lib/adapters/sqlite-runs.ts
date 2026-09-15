import type { DatabaseSync } from 'node:sqlite';
import { BionicError, type Json } from '../contracts.ts';
import { canonical, hash, inScope, prefix, scriptPath } from '../validation.ts';
import type {
  HistoryOptions,
  PayloadInfo,
  RunAccess,
  RunCall,
  RunQuery,
  RunRecord,
  RunRepository,
} from '../runs.ts';

/** Run metadata and payloads are separate so listings never load result bodies. */
export class SqliteRuns implements RunRepository {
  private options: Required<HistoryOptions>;
  constructor(
    private db: DatabaseSync,
    options: HistoryOptions = {},
    private now = Date.now,
  ) {
    this.options = {
      retainInputs: true,
      retainOutputs: true,
      ttlMs: 7 * 86400000,
      maxPayloadBytes: 262144,
      maxTotalBytes: 64 * 1024 * 1024,
      maxRuns: 5000,
      ...options,
    };
    for (const key of ['ttlMs', 'maxPayloadBytes', 'maxTotalBytes', 'maxRuns'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) {
        throw new BionicError('configuration', `Invalid history ${key}`);
      }
    }
    for (const key of ['retainInputs', 'retainOutputs'] as const) {
      if (typeof this.options[key] !== 'boolean') {
        throw new BionicError('configuration', `Invalid history ${key}`);
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_payloads(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,body TEXT NOT NULL,bytes INTEGER NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(run_id,kind));
      CREATE TABLE IF NOT EXISTS run_calls(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,call_id TEXT NOT NULL,record TEXT NOT NULL,UNIQUE(run_id,call_id));
      CREATE INDEX IF NOT EXISTS run_calls_parent ON run_calls(run_id,seq);
    `);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private update(run: RunRecord) {
    this.db.prepare('UPDATE runs SET record=? WHERE id=?').run(canonical(run), run.runId);
  }
  private raw(id: string): RunRecord {
    const row = this.db.prepare('SELECT record FROM runs WHERE id=?').get(id) as
      { record: string } | undefined;
    if (!row) {
      throw new BionicError('not_found', 'Run unavailable');
    }
    return JSON.parse(row.record);
  }
  private maintain() {
    this.db.prepare('DELETE FROM run_payloads WHERE expires<=?').run(this.now());
  }
  private visible(run: RunRecord, access: RunAccess) {
    return access.principals.includes(run.principal) && inScope(run.path, access.readPrefixes);
  }
  private describe(run: RunRecord): RunRecord {
    // A persisted deadline works across processes; opening another runtime never
    // marks a live run interrupted. Unknown is an observation, not a fabricated finish.
    if (run.status === 'running' && run.deadline <= this.now()) {
      run.status = 'unknown';
    }
    for (const kind of ['input', 'output'] as const) {
      const info = run[`${kind}Info`];
      if (
        info.state === 'available' &&
        !this.db
          .prepare('SELECT 1 FROM run_payloads WHERE run_id=? AND kind=?')
          .get(run.runId, kind)
      ) {
        info.state = 'expired';
      }
      if (run.status === 'unknown' && info.state === 'pending') {
        info.state = 'absent';
      }
    }
    return run;
  }
  private storePayload(runId: string, kind: 'input' | 'output', value: Json): PayloadInfo {
    const body = canonical(value),
      bytes = Buffer.byteLength(body);
    if (
      !this.options[kind === 'input' ? 'retainInputs' : 'retainOutputs'] ||
      bytes > this.options.maxPayloadBytes ||
      bytes > this.options.maxTotalBytes
    ) {
      return { state: 'not_retained', bytes };
    }
    const expires = this.now() + this.options.ttlMs;
    this.db
      .prepare('INSERT OR REPLACE INTO run_payloads VALUES(?,?,?,?,?)')
      .run(runId, kind, body, bytes, expires);
    let total = (
      this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM run_payloads').get() as { n: number }
    ).n;
    for (const row of this.db
      .prepare('SELECT rowid,bytes FROM run_payloads ORDER BY rowid')
      .all() as { rowid: number; bytes: number }[]) {
      if (total <= this.options.maxTotalBytes) {
        break;
      }
      this.db.prepare('DELETE FROM run_payloads WHERE rowid=?').run(row.rowid);
      total -= row.bytes;
    }
    return { state: 'available', bytes, expiresAt: new Date(expires).toISOString() };
  }
  async start(record: Omit<RunRecord, 'inputInfo' | 'outputInfo'>, input: Json) {
    return this.transaction(() => {
      this.maintain();
      const rows = this.db.prepare('SELECT id,record FROM runs ORDER BY seq').all() as {
        id: string;
        record: string;
      }[];
      let count = rows.length;
      for (const row of rows) {
        if (count < this.options.maxRuns) {
          break;
        }
        const old = JSON.parse(row.record) as RunRecord;
        if (old.status !== 'running' || old.deadline <= this.now()) {
          this.db.prepare('DELETE FROM runs WHERE id=?').run(row.id);
          count--;
        }
      }
      if (count >= this.options.maxRuns) {
        throw new BionicError('limit', 'History capacity occupied by active runs');
      }
      const run: RunRecord = {
        ...record,
        inputInfo: { state: 'pending', bytes: 0 },
        outputInfo: { state: 'pending', bytes: 0 },
      };
      this.db.prepare('INSERT INTO runs(id,record) VALUES(?,?)').run(run.runId, canonical(run));
      run.inputInfo = this.storePayload(run.runId, 'input', input);
      this.update(run);
      if (run.parentRunId) {
        const parent = this.raw(run.parentRunId);
        parent.childCount++;
        this.update(parent);
      }
      return this.describe(run);
    });
  }
  async finish(runId: string, result: Parameters<RunRepository['finish']>[1]) {
    return this.transaction(() => {
      this.maintain();
      const run = this.raw(runId);
      if (run.status !== 'running') {
        throw new BionicError('conflict', 'Run already finalized');
      }
      run.status = result.status;
      run.finishedAt = new Date(this.now()).toISOString();
      run.durationMs = Math.max(0, this.now() - Date.parse(run.startedAt));
      if (result.error) {
        run.error = result.error;
      }
      run.outputInfo =
        result.output !== undefined
          ? this.storePayload(runId, 'output', result.output)
          : { state: 'absent', bytes: 0 };
      this.update(run);
      return this.describe(run);
    });
  }
  async appendCall(runId: string, call: RunCall) {
    return this.transaction(() => {
      const count = (
        this.db.prepare('SELECT COUNT(*) AS n FROM run_calls WHERE run_id=?').get(runId) as {
          n: number;
        }
      ).n;
      if (count >= 1000) {
        throw new BionicError('limit', 'Run trace exceeds 1000 calls');
      }
      this.db
        .prepare('INSERT INTO run_calls(run_id,call_id,record) VALUES(?,?,?)')
        .run(runId, call.callId, canonical(call));
      const run = this.raw(runId);
      run.callCount++;
      this.update(run);
    });
  }
  async get(runId: string, access: RunAccess) {
    this.maintain();
    const run = this.raw(runId);
    if (!this.visible(run, access)) {
      throw new BionicError('not_found', 'Run unavailable');
    }
    return this.describe(run);
  }
  async list(query: RunQuery, access: RunAccess) {
    this.maintain();
    const path = query.path?.endsWith('.js') ? scriptPath(query.path) : prefix(query.path);
    for (const date of [query.since, query.until]) {
      if (
        date !== undefined &&
        (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)
      ) {
        throw new BionicError('invalid_input', 'Use UTC ISO timestamps');
      }
    }
    const signature = hash({ query: { ...query, cursor: undefined }, access });
    const before = this.cursor(query.cursor, signature);
    const rows = this.db
      .prepare('SELECT seq,record FROM runs WHERE seq<? ORDER BY seq DESC')
      .all(before) as { seq: number; record: string }[];
    const items: { seq: number; run: RunRecord }[] = [];
    for (const row of rows) {
      const run = this.describe(JSON.parse(row.record));
      if (
        !this.visible(run, access) ||
        !(path.endsWith('.js') ? run.path === path : run.path.startsWith(path))
      ) {
        continue;
      }
      if (query.ref && canonical(query.ref) !== canonical(run.ref)) {
        continue;
      }
      if (query.workId && run.workId !== query.workId) {
        continue;
      }
      if (
        query.parentRunId
          ? run.parentRunId !== query.parentRunId
          : !query.includeChildren && run.parentRunId !== null
      ) {
        continue;
      }
      if ((query.kind ?? 'execution') !== 'all' && run.kind !== (query.kind ?? 'execution')) {
        continue;
      }
      if (query.status && run.status !== query.status) {
        continue;
      }
      if (
        (query.since && run.startedAt < query.since) ||
        (query.until && run.startedAt > query.until)
      ) {
        continue;
      }
      items.push({ seq: row.seq, run });
      if (items.length > (query.limit ?? 10)) {
        break;
      }
    }
    return this.page(
      items.map((x) => ({ seq: x.seq, value: x.run })),
      query.limit ?? 10,
      signature,
    );
  }
  private cursor(cursor: string | undefined, signature: string): number {
    if (!cursor) {
      return Number.MAX_SAFE_INTEGER;
    }
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (
        parsed.signature !== signature ||
        !Number.isSafeInteger(parsed.before) ||
        parsed.before < 1
      ) {
        throw new Error();
      }
      return parsed.before;
    } catch {
      throw new BionicError('invalid_input', 'Invalid history cursor for this query');
    }
  }
  private page<T>(rows: { seq: number; value: T }[], limit: number, signature: string) {
    const kept = rows.slice(0, limit);
    return {
      items: kept.map((x) => x.value),
      ...(rows.length > limit
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ signature, before: kept.at(-1)!.seq }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  async calls(runId: string, access: RunAccess, limit = 20, cursor?: string) {
    await this.get(runId, access);
    const signature = hash({ runId, access, limit });
    const rows = this.db
      .prepare(
        'SELECT seq,record FROM run_calls WHERE run_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
      )
      .all(runId, this.cursor(cursor, signature), limit + 1) as { seq: number; record: string }[];
    return this.page(
      rows.map((r) => ({ seq: r.seq, value: JSON.parse(r.record) as RunCall })),
      limit,
      signature,
    );
  }
  async payload(runId: string, kind: 'input' | 'output', access: RunAccess) {
    const run = await this.get(runId, access);
    const row = this.db
      .prepare('SELECT body FROM run_payloads WHERE run_id=? AND kind=?')
      .get(runId, kind) as { body: string } | undefined;
    return {
      run,
      info: run[`${kind}Info`],
      ...(row ? { value: JSON.parse(row.body) as Json } : {}),
    };
  }
}
