import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, parse, join } from 'node:path';
import {
  BionicError,
  type Artifact,
  type Evidence,
  type EvidenceRepository,
  type PublishRequest,
  type ScriptRef,
  type ScriptRepository,
  type Summary,
} from '../contracts.ts';
import { canonical, hash, scriptPath } from '../validation.ts';

export class SqliteStore implements ScriptRepository, EvidenceRepository {
  private db: DatabaseSync;
  readonly registryId: string;
  constructor(file: string) {
    if (file !== ':memory:') {
      const absolute = resolve(file);
      let part = parse(absolute).root;
      for (const segment of absolute.slice(part.length).split('/')) {
        part = join(part, segment);
        try {
          if (lstatSync(part).isSymbolicLink()) {
            throw new BionicError('forbidden', 'Registry path cannot contain symlinks');
          }
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }
      }
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          if (lstatSync(absolute + suffix).isSymbolicLink()) {
            throw new BionicError('forbidden', 'Registry sidecar cannot be a symlink');
          }
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        }
      }
      file = join(realpathSync(dirname(absolute)), parse(absolute).base);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scripts(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,head INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(script_id TEXT NOT NULL,version INTEGER NOT NULL,artifact TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(script_id,version));
      CREATE TABLE IF NOT EXISTS publications(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,artifact TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,record TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES('registryId','${randomUUID()}');`);
    this.registryId = (
      this.db.prepare("SELECT value FROM metadata WHERE key='registryId'").get() as any
    ).value;
  }
  close() {
    this.db.close();
  }
  private decode(raw: string): Artifact {
    const artifact = JSON.parse(raw) as Artifact;
    if (
      hash({ source: artifact.source, contract: artifact.contract }) !== artifact.ref.contentHash
    ) {
      throw new BionicError('corrupt', 'Artifact hash mismatch');
    }
    return artifact;
  }
  async read(path: string, revision?: string): Promise<Artifact> {
    scriptPath(path);
    if (revision !== undefined && !/^[1-9][0-9]*$/.test(revision)) {
      throw new BionicError('invalid_input', 'Invalid revision');
    }
    const row = this.db
      .prepare(
        `SELECT r.artifact FROM scripts s JOIN revisions r ON r.script_id=s.id AND r.version=COALESCE(?,s.head) WHERE s.path=?`,
      )
      .get(revision ? Number(revision) : null, path) as any;
    if (!row) {
      throw new BionicError(
        'not_found',
        `Script not found: ${path}${revision ? '@' + revision : ''}`,
      );
    }
    return this.decode(row.artifact);
  }
  async readRef(ref: ScriptRef): Promise<Artifact> {
    if (ref.registryId !== this.registryId) {
      throw new BionicError('not_found', 'Unknown registry');
    }
    const row = this.db
      .prepare('SELECT artifact FROM revisions WHERE script_id=? AND version=?')
      .get(ref.scriptId, ref.revision) as any;
    if (!row) {
      throw new BionicError('not_found', 'Revision not found');
    }
    const artifact = this.decode(row.artifact);
    if (canonical(artifact.ref) !== canonical(ref)) {
      throw new BionicError('conflict', 'Immutable reference mismatch');
    }
    return artifact;
  }
  async list(): Promise<Summary[]> {
    return (
      this.db
        .prepare(
          'SELECT r.artifact FROM scripts s JOIN revisions r ON r.script_id=s.id AND r.version=s.head ORDER BY s.path',
        )
        .all() as any[]
    ).map((r) => {
      const a = this.decode(r.artifact);
      return { path: a.path, ref: a.ref, description: a.contract.description };
    });
  }
  async publish(request: PublishRequest): Promise<Artifact> {
    scriptPath(request.path);
    const fingerprint = hash(request);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cached = this.db
        .prepare('SELECT * FROM publications WHERE request_id=?')
        .get(request.requestId) as any;
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new BionicError('conflict', 'Request ID reused with different content');
        }
        this.db.exec('COMMIT');
        return this.decode(cached.artifact);
      }
      const current = this.db
        .prepare('SELECT * FROM scripts WHERE path=?')
        .get(request.path) as any;
      if ((current ? String(current.head) : null) !== request.expectedVersion) {
        throw new BionicError(
          'conflict',
          `Expected revision differs from current ${current?.head ?? 'absent'}`,
        );
      }
      const size = Buffer.byteLength(
        canonical({ source: request.source, contract: request.contract }),
      );
      const stats = this.db
        .prepare('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM revisions')
        .get() as any;
      if (stats.count >= 5000 || stats.bytes + size > 32 * 1024 * 1024) {
        throw new BionicError('limit', 'Registry quota exhausted');
      }
      const id = current?.id ?? randomUUID();
      const version = (current?.head ?? 0) + 1;
      const artifact: Artifact = {
        path: request.path,
        source: request.source,
        contract: request.contract,
        createdAt: new Date().toISOString(),
        ref: {
          registryId: this.registryId,
          scriptId: id,
          revision: String(version),
          contentHash: hash({ source: request.source, contract: request.contract }),
        },
      };
      const serialized = canonical(artifact);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(id, version, serialized, size);
      this.db
        .prepare(
          'INSERT INTO scripts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET head=excluded.head',
        )
        .run(id, request.path, version);
      this.db
        .prepare('INSERT INTO publications VALUES(?,?,?)')
        .run(request.requestId, fingerprint, serialized);
      this.db.exec('COMMIT');
      return artifact;
    } catch (e) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw e;
    }
  }
  async append(record: Evidence) {
    const serialized = canonical(record);
    const previous = this.db
      .prepare('SELECT record FROM evidence WHERE id=?')
      .get(record.id) as any;
    if (previous && previous.record !== serialized) {
      throw new BionicError('conflict', 'Evidence ID reused');
    }
    this.db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?)').run(record.id, serialized);
  }
  async recent(limit: number): Promise<Evidence[]> {
    return (
      this.db
        .prepare('SELECT record FROM evidence ORDER BY rowid DESC LIMIT ?')
        .all(Math.max(1, Math.min(limit, 100))) as any[]
    ).map((r) => JSON.parse(r.record));
  }
}
