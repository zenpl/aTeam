import type { DatabaseSync as Db } from "node:sqlite";
// node:sqlite is newer than the bundlers' list of built-ins; ask Node for it directly so tests can load this file too.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): typeof import("node:sqlite") }).getBuiltinModule("node:sqlite");
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore, Event, Log, Cursor, Delivery } from "@ateam/core";
import { hashKey, newKey, newCode, projectId, INVITE_TTL_MS, type Registry, type Project, type KeyRecord, type Invite } from "./projects.js";

/**
 * One SQLite file holds every project. Rows carry a `project` column; a log that predates projects (t-041) is
 * migrated on open into `defaultProject`, so the first project keeps its events, cursors and deliveries.
 */
export class SqliteDb {
  readonly db: Db;

  constructor(path: string, defaultProject = "ateam") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (actor TEXT PRIMARY KEY, last_event_id TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (event_id TEXT NOT NULL, to_actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (event_id, to_actor));
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys (hash TEXT PRIMARY KEY, project TEXT NOT NULL, role TEXT, agent_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, project TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    `);
    const cols = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
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
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_project ON events (project, id)`);
  }
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

  async since(after: string | null): Promise<Event[]> {
    const rows = after
      ? this.db.prepare("SELECT json FROM events WHERE project = ? AND id > ? ORDER BY id").all(this.project, after)
      : this.db.prepare("SELECT json FROM events WHERE project = ? ORDER BY id").all(this.project);
    return (rows as { json: string }[]).map((r) => JSON.parse(r.json) as Event);
  }

  async appendRaw(e: Event): Promise<void> {
    this.db.prepare("INSERT INTO events (id, at, actor, kind, json, project) VALUES (?, ?, ?, ?, ?, ?)").run(e.id, e.at, e.actor, e.kind, JSON.stringify(e), this.project);
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
    const project: Project = { id: projectId(name), name: name.trim() || "未命名", created_at: now.toISOString() };
    this.db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(project.id, project.name, project.created_at);
    const admin_key = await this.addKey(project.id, null, undefined, now);
    const invite = await this.createInvite(project.id, now);
    return { project, admin_key, invite };
  }
  async get(id: string) { return (this.db.prepare("SELECT id, name, created_at FROM projects WHERE id = ?").get(id) as Project | undefined) ?? null; }
  async ensure(id: string, name: string, adminKey: string | undefined, now = new Date()) {
    this.db.prepare("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now.toISOString());
    if (adminKey) this.db.prepare("INSERT OR IGNORE INTO keys (hash, project, role, agent_id, created_at) VALUES (?, ?, NULL, NULL, ?)").run(hashKey(adminKey), id, now.toISOString());
    return (await this.get(id))!;
  }
  async lookup(key: string) {
    const r = this.db.prepare("SELECT project, role, agent_id, created_at FROM keys WHERE hash = ?").get(hashKey(key)) as (KeyRecord & { agent_id: string | null }) | undefined;
    return r ? { project: r.project, role: r.role, agent_id: r.agent_id ?? undefined, created_at: r.created_at } : null;
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
}
