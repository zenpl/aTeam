import type { DatabaseSync as Db } from "node:sqlite";
// node:sqlite is newer than the bundlers' list of built-ins; ask Node for it directly so tests can load this file too.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): typeof import("node:sqlite") }).getBuiltinModule("node:sqlite");
import { mkdirSync, existsSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { append, SERVICE_ACTOR, PROJECT_SURFACE } from "@ateam/core";
import type { EventStore, Event, Log, Cursor, Delivery, LogMark } from "@ateam/core";
import { randomBytes } from "node:crypto";
import { hashKey, newKey, newCode, projectId, deriveNodeKey, INVITE_TTL_MS, OWNER_AGENT, type Registry, type Project, type KeyRecord, type Invite } from "./projects.js";

/**
 * One SQLite file holds every project. Rows carry a `project` column; a log that predates projects (t-041) is
 * migrated on open into `defaultProject`, so the first project keeps its events, cursors and deliveries.
 */
export interface SqliteDbOptions {
  now?: () => Date;
  /** Free bytes on the volume holding `dir` (default: statfs). */
  freeBytes?: (dir: string) => number;
  /** Copy the live database to `target` (default: VACUUM INTO, a consistent copy even with a WAL). */
  copy?: (db: Db, target: string) => void;
}

/** What a migration wrote before it ran (t-053): where the copy is and how big; recorded in the default project's log. */
export interface BackupRecord { migration: string; path: string; bytes: number }

export class SqliteDb {
  readonly db: Db;
  /** Set when opening this file required a schema migration: the backup taken first. */
  readonly backup?: BackupRecord;

  constructor(path: string, defaultProject = "ateam", opts: SqliteDbOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const cols0 = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const hasTable = (t: string) => !!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    // t-041's migration: rows gain a project column. Before touching an existing file, copy it (t-053): the team deploys
    // without a way to snapshot the volume, so a migration must carry its own way back.
    const needsProjects = path !== ":memory:" && hasTable("events") && !cols0("events").includes("project");
    if (needsProjects) this.backup = backupBefore(this.db, path, "projects", opts);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (actor TEXT PRIMARY KEY, last_event_id TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (event_id TEXT NOT NULL, to_actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (event_id, to_actor));
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, node_secret TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS keys (hash TEXT PRIMARY KEY, project TEXT NOT NULL, role TEXT, agent_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, project TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_counts (project TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
    const cols = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    if (!cols("keys").includes("used_at")) this.db.exec("ALTER TABLE keys ADD COLUMN used_at TEXT"); // t-103
    if (!cols("events").includes("project")) this.db.exec(`ALTER TABLE events ADD COLUMN project TEXT NOT NULL DEFAULT ${q(defaultProject)}`);
    if (!cols("deliveries").includes("project")) this.db.exec(`ALTER TABLE deliveries ADD COLUMN project TEXT NOT NULL DEFAULT ${q(defaultProject)}`);
    if (!cols("cursors").includes("project")) {
      // the primary key becomes (project, actor): rebuild the table, keeping every row in the default project
      this.db.exec(`
        CREATE TABLE cursors_v2 (project TEXT NOT NULL, actor TEXT NOT NULL, last_event_id TEXT, at TEXT NOT NULL, PRIMARY KEY (project, actor));
        INSERT INTO cursors_v2 (project, actor, last_event_id, at) SELECT ${q(defaultProject)}, actor, last_event_id, at FROM cursors;
        DROP TABLE cursors;
        ALTER TABLE cursors_v2 RENAME TO cursors;
      `);
    }
    if (!cols("projects").includes("node_secret")) this.db.exec(`ALTER TABLE projects ADD COLUMN node_secret TEXT NOT NULL DEFAULT ''`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_project ON events (project, id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS deliveries_project_at ON deliveries (project, at)`); // t-128
    // t-128: how many events each project holds, so the incremental reduction's one safety check is a lookup and not a
    // scan. Counting the rows is what a fresh file (or one written before this table existed) pays, once, at open.
    this.db.exec(`INSERT OR IGNORE INTO event_counts (project, n) SELECT project, COUNT(*) FROM events GROUP BY project`);
  }
}

/** Take the copy, or throw: no backup, no migration. */
function backupBefore(db: Db, path: string, migration: string, opts: SqliteDbOptions): BackupRecord {
  const now = opts.now?.() ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const base = `${path}.pre-${migration}-${stamp}.bak`;
  let target = base;
  for (let n = 1; existsSync(target); n++) target = `${base}.${n}`;
  const size = statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
  const free = (opts.freeBytes ?? ((dir) => { const f = statfsSync(dir); return Number(f.bavail) * Number(f.bsize); }))(dirname(path));
  if (free < size) throw new Error(`refusing to migrate ${path} (${migration}): a backup needs ${size} bytes, the volume has ${free} free`);
  try {
    (opts.copy ?? ((d, t) => d.exec(`VACUUM INTO '${t.replace(/'/g, "''")}'`)))(db, target);
  } catch (err) {
    throw new Error(`refusing to migrate ${path} (${migration}): backup to ${target} failed: ${(err as Error).message}`);
  }
  if (!existsSync(target) || statSync(target).size === 0) throw new Error(`refusing to migrate ${path} (${migration}): backup ${target} is missing or empty`);
  return { migration, path: target, bytes: statSync(target).size };
}

/** After a migration ran, tell the log where the copy is, so anyone can check it later. */
export async function recordBackup(store: EventStore, backup: BackupRecord, human: string, now?: Date): Promise<void> {
  await append(store, {
    kind: "reading", actor: SERVICE_ACTOR, surface: PROJECT_SURFACE, key: "backup.path", value: { path: backup.path, bytes: backup.bytes, migration: backup.migration },
    method: `服务启动时在 schema 迁移（${backup.migration}）之前用 VACUUM INTO 复制到同一卷`,
  }, { human, now });
}

export class SqliteStore implements EventStore {
  constructor(private sdb: SqliteDb, private project: string) {}
  private get db() { return this.sdb.db; }

  async read(): Promise<Log> {
    const events = (this.db.prepare("SELECT json FROM events WHERE project = ? ORDER BY id").all(this.project) as { json: string }[]).map((r) => JSON.parse(r.json) as Event);
    const cursors = this.db.prepare("SELECT actor, last_event_id, at FROM cursors WHERE project = ?").all(this.project) as unknown as Cursor[];
    const deliveries = (this.db.prepare("SELECT event_id, to_actor, at FROM deliveries WHERE project = ?").all(this.project) as { event_id: string; to_actor: string; at: string }[])
      .map((d) => ({ event_id: d.event_id, to: d.to_actor, at: d.at }));
    return { events, cursors, deliveries };
  }

  /**
   * t-128: the rows a reduction has not folded yet. Events come by id, deliveries from the last instant seen inclusive
   * (they share timestamps, and applying one twice does nothing), cursors whole — there is one per node, not one per
   * event. The count is the guard: if the store holds more events than the caller has folded, it rebuilds.
   */
  async readSince(mark: LogMark | null): Promise<{ log: Log; mark: LogMark; events: number }> {
    const rows = mark?.event
      ? this.db.prepare("SELECT id, json FROM events WHERE project = ? AND id > ? ORDER BY id").all(this.project, mark.event)
      : this.db.prepare("SELECT id, json FROM events WHERE project = ? ORDER BY id").all(this.project);
    const events = (rows as { id: string; json: string }[]).map((r) => JSON.parse(r.json) as Event);
    const drows = mark?.delivery
      ? this.db.prepare("SELECT event_id, to_actor, at FROM deliveries WHERE project = ? AND at >= ?").all(this.project, mark.delivery)
      : this.db.prepare("SELECT event_id, to_actor, at FROM deliveries WHERE project = ?").all(this.project);
    const deliveries = (drows as { event_id: string; to_actor: string; at: string }[]).map((d) => ({ event_id: d.event_id, to: d.to_actor, at: d.at }));
    const cursors = this.db.prepare("SELECT actor, last_event_id, at FROM cursors WHERE project = ?").all(this.project) as unknown as Cursor[];
    const last = this.db.prepare("SELECT id FROM events WHERE project = ? ORDER BY id DESC LIMIT 1").get(this.project) as { id: string } | undefined;
    const newest = this.db.prepare("SELECT at FROM deliveries WHERE project = ? ORDER BY at DESC LIMIT 1").get(this.project) as { at: string } | undefined;
    const events_total = ((this.db.prepare("SELECT n FROM event_counts WHERE project = ?").get(this.project) as { n: number } | undefined)?.n) ?? 0;
    return { log: { events, cursors, deliveries }, mark: { event: last?.id ?? null, delivery: newest?.at ?? null }, events: events_total };
  }

  async since(after: string | null): Promise<Event[]> {
    const rows = after
      ? this.db.prepare("SELECT json FROM events WHERE project = ? AND id > ? ORDER BY id").all(this.project, after)
      : this.db.prepare("SELECT json FROM events WHERE project = ? ORDER BY id").all(this.project);
    return (rows as { json: string }[]).map((r) => JSON.parse(r.json) as Event);
  }

  async appendRaw(e: Event): Promise<void> {
    this.db.prepare("INSERT INTO events (id, at, actor, kind, json, project) VALUES (?, ?, ?, ?, ?, ?)").run(e.id, e.at, e.actor, e.kind, JSON.stringify(e), this.project);
    this.db.prepare("INSERT INTO event_counts (project, n) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET n = n + 1").run(this.project);
  }

  async setCursor(c: Cursor): Promise<void> {
    this.db.prepare("INSERT INTO cursors (project, actor, last_event_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(project, actor) DO UPDATE SET last_event_id = excluded.last_event_id, at = excluded.at")
      .run(this.project, c.actor, c.last_event_id, c.at);
  }

  async recordDelivery(d: Delivery): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO deliveries (event_id, to_actor, at, project) VALUES (?, ?, ?, ?)").run(d.event_id, d.to, d.at, this.project);
  }
}

export class SqliteRegistry implements Registry {
  constructor(private sdb: SqliteDb) {}
  private get db() { return this.sdb.db; }

  async create(name: string, now = new Date()) {
    const project: Project = { id: projectId(name), name: name.trim() || "未命名", created_at: now.toISOString(), node_secret: randomBytes(24).toString("base64url") };
    this.db.prepare("INSERT INTO projects (id, name, created_at, node_secret) VALUES (?, ?, ?, ?)").run(project.id, project.name, project.created_at, project.node_secret);
    const admin_key = await this.addKey(project.id, null, undefined, now);
    const invite = await this.createInvite(project.id, now);
    return { project, admin_key, invite };
  }
  async get(id: string) { return (this.db.prepare("SELECT id, name, created_at, node_secret FROM projects WHERE id = ?").get(id) as Project | undefined) ?? null; }
  async list() { return this.db.prepare("SELECT id, name, created_at, node_secret FROM projects ORDER BY created_at").all() as unknown as Project[]; }
  async ensure(id: string, name: string, adminKey: string | undefined, now = new Date()) {
    this.db.prepare("INSERT OR IGNORE INTO projects (id, name, created_at, node_secret) VALUES (?, ?, ?, ?)").run(id, name, now.toISOString(), randomBytes(24).toString("base64url"));
    this.db.prepare("UPDATE projects SET node_secret = ? WHERE id = ? AND node_secret = ''").run(randomBytes(24).toString("base64url"), id);
    if (adminKey) this.db.prepare("INSERT OR IGNORE INTO keys (hash, project, role, agent_id, created_at) VALUES (?, ?, NULL, NULL, ?)").run(hashKey(adminKey), id, now.toISOString());
    return (await this.get(id))!;
  }
  async lookup(key: string) {
    const r = this.db.prepare("SELECT project, role, agent_id, created_at, used_at FROM keys WHERE hash = ?").get(hashKey(key)) as (KeyRecord & { agent_id: string | null; used_at: string | null }) | undefined;
    return r ? { project: r.project, role: r.role, agent_id: r.agent_id ?? undefined, created_at: r.created_at, used_at: r.used_at ?? undefined } : null;
  }
  async ownerKey(project: string, human: string, now = new Date()) { return this.nodeKey(project, OWNER_AGENT, human, now); }
  async ownerKeyRecord(project: string) {
    const p = await this.get(project);
    return p ? this.lookup(deriveNodeKey(p.node_secret, OWNER_AGENT)) : null;
  }
  async markUsed(key: string, now = new Date()) {
    this.db.prepare("UPDATE keys SET used_at = ? WHERE hash = ? AND used_at IS NULL").run(now.toISOString(), hashKey(key));
  }
  async addKey(project: string, role: string | null, agentId?: string, now = new Date()) {
    const key = newKey(role ? "nk" : "ak");
    this.db.prepare("INSERT INTO keys (hash, project, role, agent_id, created_at) VALUES (?, ?, ?, ?, ?)").run(hashKey(key), project, role, agentId ?? null, now.toISOString());
    return key;
  }
  async createInvite(project: string, now = new Date(), ttlMs = INVITE_TTL_MS) {
    const invite: Invite = { code: newCode(), project, created_at: now.toISOString(), expires_at: new Date(now.getTime() + ttlMs).toISOString() };
    this.db.prepare("INSERT INTO invites (code, project, created_at, expires_at) VALUES (?, ?, ?, ?)").run(invite.code, invite.project, invite.created_at, invite.expires_at);
    return invite;
  }
  async getInvite(code: string) { return (this.db.prepare("SELECT code, project, created_at, expires_at FROM invites WHERE code = ?").get(code) as Invite | undefined) ?? null; }
  async currentInvite(project: string, now = new Date()) {
    const live = this.db.prepare("SELECT code, project, created_at, expires_at FROM invites WHERE project = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(project, now.toISOString()) as Invite | undefined;
    return live ?? this.createInvite(project, now);
  }
  async nodes(project: string) {
    return (this.db.prepare("SELECT project, role, agent_id, created_at, used_at FROM keys WHERE project = ? AND role IS NOT NULL AND (agent_id IS NULL OR agent_id != ?)").all(project, OWNER_AGENT) as unknown as (KeyRecord & { agent_id: string | null; used_at: string | null })[])
      .map((r) => ({ project: r.project, role: r.role, agent_id: r.agent_id ?? undefined, created_at: r.created_at, used_at: r.used_at ?? undefined }));
  }
  async nodeKey(project: string, agentId: string, role: string, now = new Date()) {
    const p = (await this.get(project))!;
    const key = deriveNodeKey(p.node_secret, agentId);
    const existing = await this.lookup(key);
    if (existing) return { key, record: existing, created: false };
    this.db.prepare("INSERT INTO keys (hash, project, role, agent_id, created_at) VALUES (?, ?, ?, ?, ?)").run(hashKey(key), project, role, agentId, now.toISOString());
    return { key, record: { project, role, agent_id: agentId, created_at: now.toISOString() }, created: true };
  }
}
