/**
 * Projects and keys (t-041). A project = one board, one log, one key. Keys are shown once and stored hashed.
 * The registry is the only thing that knows which key opens which project; stores are per project.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export interface Project { id: string; name: string; created_at: string; /** derives node keys, so the same agent gets the same key again */ node_secret: string }
/**
 * What a presented key is: which project, and (for a node key, t-042) which role it is bound to. `used_at` (t-103) is
 * the first time it opened anything: it is what tells "we handed the owner their address" from "they have opened it".
 */
export interface KeyRecord { project: string; role: string | null; agent_id?: string; created_at: string; used_at?: string }
export interface Invite { code: string; project: string; created_at: string; expires_at: string }

export interface Registry {
  create(name: string, now?: Date): Promise<{ project: Project; admin_key: string; invite: Invite }>;
  get(id: string): Promise<Project | null>;
  list(): Promise<Project[]>;
  /** The project the default (unprefixed) address means, created on first start with the legacy key as its admin key. */
  ensure(id: string, name: string, adminKey: string | undefined, now?: Date): Promise<Project>;
  lookup(key: string): Promise<KeyRecord | null>;
  /** Mint a key for a project: admin (role null) or node (role set). Returns the key itself, once. */
  addKey(project: string, role: string | null, agentId?: string, now?: Date): Promise<string>;
  createInvite(project: string, now?: Date, ttlMs?: number): Promise<Invite>;
  getInvite(code: string): Promise<Invite | null>;
  /** The latest invite of a project that is still valid, or a fresh one. */
  currentInvite(project: string, now?: Date): Promise<Invite>;
  /** Node keys (role set) of a project, with who holds them. The owner's key is not a node and never appears here (t-103). */
  nodes(project: string): Promise<KeyRecord[]>;
  /** The node key for this agent in this project: the same key every time (t-042 idempotent join). Creates it with `role` when new. */
  nodeKey(project: string, agentId: string, role: string, now?: Date): Promise<{ key: string; record: KeyRecord; created: boolean }>;
  /**
   * t-103: the owner's key — a node key bound to the human's identity, derived like any other, so a node holding the
   * admin key can re-derive and re-send the board address without anything having been stored in the clear.
   */
  ownerKey(project: string, human: string, now?: Date): Promise<{ key: string; record: KeyRecord; created: boolean }>;
  /** t-103: the owner key's record if one was ever handed out, without creating one — asking must not count as giving. */
  ownerKeyRecord(project: string, human: string): Promise<KeyRecord | null>;
  /** t-103: record that a key was actually presented. First use is what flips a project to enforcing owner identity. */
  markUsed(key: string, now?: Date): Promise<void>;
}

/** t-103: the agent id the owner's key is derived under. One per project; never an agent that joined. */
export const OWNER_AGENT = "__owner__";

/** A node key is a function of the project's secret and the agent id, so joining twice yields the same key without storing it. */
export function deriveNodeKey(secret: string, agentId: string): string {
  return `nk_${createHmac("sha256", secret).update(agentId).digest("base64url").slice(0, 32)}`;
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
    const project = { id: projectId(name), name: name.trim() || "未命名", created_at: now.toISOString(), node_secret: randomBytes(24).toString("base64url") };
    this.projects.set(project.id, project);
    const admin_key = await this.addKey(project.id, null, undefined, now);
    const invite = await this.createInvite(project.id, now);
    return { project, admin_key, invite };
  }
  async get(id: string) { return this.projects.get(id) ?? null; }
  async list() { return [...this.projects.values()]; }
  async ensure(id: string, name: string, adminKey: string | undefined, now = new Date()) {
    let p = this.projects.get(id);
    if (!p) { p = { id, name, created_at: now.toISOString(), node_secret: randomBytes(24).toString("base64url") }; this.projects.set(id, p); }
    if (adminKey && !this.keys.has(hashKey(adminKey))) this.keys.set(hashKey(adminKey), { project: id, role: null, created_at: now.toISOString() });
    return p;
  }
  async lookup(key: string) { return this.keys.get(hashKey(key)) ?? null; }
  async ownerKey(project: string, human: string, now = new Date()) { return this.nodeKey(project, OWNER_AGENT, human, now); }
  async ownerKeyRecord(project: string) {
    const p = this.projects.get(project);
    return p ? this.keys.get(hashKey(deriveNodeKey(p.node_secret, OWNER_AGENT))) ?? null : null;
  }
  async markUsed(key: string, now = new Date()) {
    const r = this.keys.get(hashKey(key));
    if (r && !r.used_at) r.used_at = now.toISOString();
  }
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
  async currentInvite(project: string, now = new Date()) {
    const live = [...this.invites.values()].filter((i) => i.project === project && i.expires_at > now.toISOString()).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return live ?? this.createInvite(project, now);
  }
  async nodes(project: string) { return [...this.keys.values()].filter((k) => k.project === project && k.role !== null && k.agent_id !== OWNER_AGENT); }
  async nodeKey(project: string, agentId: string, role: string, now = new Date()) {
    const key = deriveNodeKey(this.projects.get(project)!.node_secret, agentId);
    const existing = this.keys.get(hashKey(key));
    if (existing) return { key, record: existing, created: false };
    const record: KeyRecord = { project, role, agent_id: agentId, created_at: now.toISOString() };
    this.keys.set(hashKey(key), record);
    return { key, record, created: true };
  }
}
