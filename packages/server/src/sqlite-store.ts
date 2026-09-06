import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore, Event, Log, Cursor, Delivery } from "@ateam/core";

export class SqliteStore implements EventStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (actor TEXT PRIMARY KEY, last_event_id TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (event_id TEXT NOT NULL, to_actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (event_id, to_actor));
    `);
  }

  async read(): Promise<Log> {
    const events = (this.db.prepare("SELECT json FROM events ORDER BY id").all() as { json: string }[]).map((r) => JSON.parse(r.json) as Event);
    const cursors = this.db.prepare("SELECT actor, last_event_id, at FROM cursors").all() as unknown as Cursor[];
    const deliveries = (this.db.prepare("SELECT event_id, to_actor, at FROM deliveries").all() as { event_id: string; to_actor: string; at: string }[])
      .map((d) => ({ event_id: d.event_id, to: d.to_actor, at: d.at }));
    return { events, cursors, deliveries };
  }

  async since(after: string | null): Promise<Event[]> {
    const rows = after
      ? this.db.prepare("SELECT json FROM events WHERE id > ? ORDER BY id").all(after)
      : this.db.prepare("SELECT json FROM events ORDER BY id").all();
    return (rows as { json: string }[]).map((r) => JSON.parse(r.json) as Event);
  }

  async appendRaw(e: Event): Promise<void> {
    this.db.prepare("INSERT INTO events (id, at, actor, kind, json) VALUES (?, ?, ?, ?, ?)").run(e.id, e.at, e.actor, e.kind, JSON.stringify(e));
  }

  async setCursor(c: Cursor): Promise<void> {
    this.db.prepare("INSERT INTO cursors (actor, last_event_id, at) VALUES (?, ?, ?) ON CONFLICT(actor) DO UPDATE SET last_event_id = excluded.last_event_id, at = excluded.at")
      .run(c.actor, c.last_event_id, c.at);
  }

  async recordDelivery(d: Delivery): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO deliveries (event_id, to_actor, at) VALUES (?, ?, ?)").run(d.event_id, d.to, d.at);
  }
}
