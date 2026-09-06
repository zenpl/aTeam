/**
 * Projects and keys (t-041). A project = one board, one log, one key. Keys are shown once and stored hashed.
 * The registry is the only thing that knows which key opens which project; stores are per project.
 */
import { createHash, randomBytes } from "node:crypto";

export interface Project { id: string; name: string; created_at: string }
/** What a presented key is: which project, and (for a node key, t-042) which role it is bound to. */
export interface KeyRecord { project: string; role: string | null; agent_id?: string; created_at: string }
export interface Invite { code: string; project: string; created_at: string; expires_at: string }

export interface Registry {
  create(name: string, now?: Date): Promise<{ project: Project; admin_key: string; invite: Invite }>;
  get(id: string): Promise<Project | null>;
  /** The project the default (unprefixed) address means, created on first start with the legacy key as its admin key. */
  ensure(id: string, name: string, adminKey: string | undefined, now?: Date): Promise<Project>;
  lookup(key: string): Promise<KeyRecord | null>;
  /** Mint a key for a project: admin (role null) or node (role set). Returns the key itself, once. */
  addKey(project: string, role: string | null, agentId?: string, now?: Date): Promise<string>;
  createInvite(project: string, now?: Date, ttlMs?: number): Promise<Invite>;
  getInvite(code: string): Promise<Invite | null>;
}

export const INVITE_TTL_MS = 24 * 3600_000;

export function hashKey(key: string): string { return createHash("sha256").update(key).digest("hex"); }
export function newKey(prefix: "ak" | "nk"): string { return `${prefix}_${randomBytes(24).toString("base64url")}`; }
export function newCode(): string { return randomBytes(9).toString("base64url"); }

/** A URL-safe project id from its name plus a short random tail, so two "demo" projects never collide. */
export function projectId(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return `${slug || "p"}-${randomBytes(3).toString("hex")}`;
}

export class MemoryRegistry implements Registry {
  projects = new Map<string, Project>();
  keys = new Map<string, KeyRecord>();
  invites = new Map<string, Invite>();

  async create(name: string, now = new Date()) {
    const project = { id: projectId(name), name: name.trim() || "未命名", created_at: now.toISOString() };
    this.projects.set(project.id, project);
    const admin_key = await this.addKey(project.id, null, undefined, now);
    const invite = await this.createInvite(project.id, now);
    return { project, admin_key, invite };
  }
  async get(id: string) { return this.projects.get(id) ?? null; }
  async ensure(id: string, name: string, adminKey: string | undefined, now = new Date()) {
    let p = this.projects.get(id);
    if (!p) { p = { id, name, created_at: now.toISOString() }; this.projects.set(id, p); }
    if (adminKey && !this.keys.has(hashKey(adminKey))) this.keys.set(hashKey(adminKey), { project: id, role: null, created_at: now.toISOString() });
    return p;
  }
  async lookup(key: string) { return this.keys.get(hashKey(key)) ?? null; }
  async addKey(project: string, role: string | null, agent_id?: string, now = new Date()) {
    const key = newKey(role ? "nk" : "ak");
    this.keys.set(hashKey(key), { project, role, agent_id, created_at: now.toISOString() });
    return key;
  }
  async createInvite(project: string, now = new Date(), ttlMs = INVITE_TTL_MS) {
    const invite = { code: newCode(), project, created_at: now.toISOString(), expires_at: new Date(now.getTime() + ttlMs).toISOString() };
    this.invites.set(invite.code, invite);
    return invite;
  }
  async getInvite(code: string) { return this.invites.get(code) ?? null; }
}
