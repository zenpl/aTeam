/**
 * t-039: the manual is served by the service, per role, and holds for any project: no words from this project's own file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, manualRoles } from "@ateam/core";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let base = "";
beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: "secret", human: "human", sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

/** This project's own conventions: none of them may appear in the platform's manual (product.md, overfit list). */
const OVERFIT = [/pnpm/i, /\bfly\b/i, /deploy/i, /production/i, /deployed\.sha/i, /github/i, /staging/i, /CLAUDE\.md/i, /sha\b/i, /git\b/i];

describe("t-040 · the address is the toolkit", () => {
  it("GET / without text/html in Accept is the newcomer's manual, with this address filled in; a browser still gets the board", async () => {
    for (const headers of [{}, { accept: "*/*" }, { accept: "application/json" }]) {
      const r = await fetch(`${base}/`, { headers });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      const text = await r.text();
      expect(text).toContain("# 这是什么，怎么加入");
      expect(text).toContain(`curl -sS -X POST ${base}/projects`);
      expect(text).toContain(`${base}/invite/<code>/join`);
      expect(text).toContain(`${base}/manual/<角色>`);
      expect(text).not.toContain("{{base}}");
      for (const re of OVERFIT) expect(text, String(re)).not.toMatch(re);
    }
    const browser = await fetch(`${base}/`, { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(browser.headers.get("content-type")).toContain("text/html");
  });

  it("GET /manual is the same manual; https is honoured behind a proxy", async () => {
    const a = await (await fetch(`${base}/manual`)).text();
    const b = await (await fetch(`${base}/`)).text();
    expect(a).toBe(b);
    const proxied = await (await fetch(`${base}/manual`, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "ateam.example" } })).text();
    expect(proxied).toContain("https://ateam.example/projects");
  });

  it("names every step a stranger needs: new project, invite join, first node, sync/ack, role manual", async () => {
    const text = await (await fetch(`${base}/manual`)).text();
    for (const must of ["POST", "/projects", "admin_key", "invite_url", "/join", "agent_id", "node_key", "第一个", "pm", "events?after=", "wait=25000", '"kind":"ack"', "X-Actor", "/board", "ateam join"]) expect(text).toContain(must);
  });
});

describe("t-039 · GET /manual/<role>", () => {
  it("serves every role it is written for as Markdown, without a key", async () => {
    expect(manualRoles()).toEqual(["dev", "frontend", "pd", "pm", "qa"]);
    for (const role of manualRoles()) {
      const r = await fetch(`${base}/manual/${role}`);
      expect(r.status, role).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      const text = await r.text();
      expect(text).toContain("# 说明书 · 通用核心");
      expect(text).toContain(`# 角色 · ${role}`);
      for (const re of OVERFIT) expect(text, `${role}: ${re}`).not.toMatch(re);
    }
  });

  it("covers the core protocol: pull then ack, facts with source and validity, three-way separation, seams, 280-char instructions with ack", async () => {
    const text = await (await fetch(`${base}/manual/dev`)).text();
    for (const must of ["ateam sync", "先 ack", "有效的事实", "--method", "三方分离", "接缝", "280 字", "ack_by", "touches", "表面", "触点"]) expect(text).toContain(must);
  });

  it("404 for a role it is not written for, or a path that is not a role", async () => {
    for (const bad of ["writer", "human", "dev.md", "", "%2e%2e%2fcommon"]) expect((await fetch(`${base}/manual/${bad}`)).status, bad).toBe(404);
  });
});
