/**
 * t-053: a schema migration takes a copy of the database first, on the same volume, and says so in the log.
 * No copy, no migration.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb, SqliteStore, recordBackup } from "../src/sqlite-store.js";

const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): typeof import("node:sqlite") }).getBuiltinModule("node:sqlite");

function oldDb(dir: string): string {
  const file = join(dir, "a.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE cursors (actor TEXT PRIMARY KEY, last_event_id TEXT, at TEXT NOT NULL);
    CREATE TABLE deliveries (event_id TEXT NOT NULL, to_actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (event_id, to_actor));
    INSERT INTO events VALUES ('01A', '2026-01-01T00:00:00.000Z', 'pm', 'note', '{"id":"01A","at":"2026-01-01T00:00:00.000Z","actor":"pm","kind":"note","body":"老日志"}');
  `);
  old.close();
  return file;
}
const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "ateam-bak-"));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const NOW = new Date(Date.now() - 60_000); // one fixed moment per run: the stamp in the name must match what the test computes
const at = () => NOW;

describe("t-053 · backup before migration", () => {
  it("an old file is copied next to itself before the migration, and the log gets a backup.path fact with the size", () => withDir(async (dir) => {
    const file = oldDb(dir);
    const sdb = new SqliteDb(file, "ateam", { now: at });
    expect(sdb.backup).toBeDefined();
    const stamp = at().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    expect(sdb.backup!.path).toBe(`${file}.pre-projects-${stamp}.bak`);
    expect(existsSync(sdb.backup!.path)).toBe(true);
    expect(sdb.backup!.bytes).toBe(statSync(sdb.backup!.path).size);
    expect(sdb.backup!.bytes).toBeGreaterThan(0);
    // the copy is a readable database with the old rows
    const copy = new DatabaseSync(sdb.backup!.path);
    expect((copy.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(1);
    copy.close();
    const store = new SqliteStore(sdb, "ateam");
    await recordBackup(store, sdb.backup!, "human", at());
    const log = await store.read();
    const fact = log.events.find((e) => e.kind === "reading" && e.key === "backup.path");
    expect(fact).toMatchObject({ actor: "ateam", surface: "project", value: { path: sdb.backup!.path, bytes: sdb.backup!.bytes, migration: "projects" } });
    // no migration needed on the next open: nothing copied, nothing written
    const before = readdirSync(dir).length;
    const again = new SqliteDb(file, "ateam", { now: at });
    expect(again.backup).toBeUndefined();
    expect(readdirSync(dir).length).toBe(before);
    expect((await new SqliteStore(again, "ateam").read()).events.filter((e) => e.kind === "reading")).toHaveLength(1);
  }));

  it("a backup name that already exists gets a suffix instead of being overwritten", () => withDir(async (dir) => {
    const file = oldDb(dir);
    const stamp = at().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const taken = `${file}.pre-projects-${stamp}.bak`;
    const other = new DatabaseSync(taken); other.exec("CREATE TABLE x (y)"); other.close();
    const sizeBefore = statSync(taken).size;
    const sdb = new SqliteDb(file, "ateam", { now: at });
    expect(sdb.backup!.path).toBe(`${taken}.1`);
    expect(statSync(taken).size).toBe(sizeBefore);
    expect(existsSync(`${taken}.1`)).toBe(true);
  }));

  it("refuses to migrate when the copy fails or the volume is too small; the file is left as it was", () => withDir(async (dir) => {
    const file = oldDb(dir);
    expect(() => new SqliteDb(file, "ateam", { now: at, copy: () => { throw new Error("EIO"); } })).toThrow(/refusing to migrate .*backup to .* failed: EIO/);
    expect(() => new SqliteDb(file, "ateam", { now: at, freeBytes: () => 10 })).toThrow(/refusing to migrate .*needs \d+ bytes, the volume has 10 free/);
    const raw = new DatabaseSync(file);
    const cols = (raw.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("project"); // untouched
    raw.close();
    expect(readdirSync(dir).filter((f) => f.includes(".bak"))).toEqual([]);
  }));

  it("a fresh or already-migrated file needs no backup", () => withDir(async (dir) => {
    const sdb = new SqliteDb(join(dir, "new.db"), "ateam", { now: at });
    expect(sdb.backup).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.includes(".bak"))).toEqual([]);
  }));
});
