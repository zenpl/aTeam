/**
 * t-039: the manual is served by the service, per role, and holds for any project: no words from this project's own file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, manualRoles } from "@ateam/core";
import { readFileSync } from "node:fs";
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

describe("t-059 · the manual ends with what this project says the role holds", () => {
  it("default packing for a plain role list; the project's own {role: [ids]} when declared; a role with nothing says so", async () => {
    const post = (actor: string, body: unknown) => fetch(`${base}/events`, { method: "POST", headers: { authorization: "Bearer secret", "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    let text = await (await fetch(`${base}/manual/qa`)).text();
    expect(text).toContain("## 你在这个项目里持有的职责\n\n- **R6 验收**：");
    text = await (await fetch(`${base}/manual/pm`)).text();
    for (const id of ["R1 定方向", "R3 定验收标准", "R4 拆分派活", "R8 接缝与集成", "R11 改进工具", "R13 协作报告"]) expect(text).toContain(`- **${id}**：`);
    expect((await post("pm", { kind: "reading", surface: "project", key: "roles", value: { pm: ["R1", "R4", "R6"], dev: ["R5"], qa: [] } })).status).toBe(201);
    text = await (await fetch(`${base}/manual/pm`)).text();
    expect(text).toContain("- **R1 定方向**：");
    expect(text).toContain("- **R4 拆分派活**：");
    expect(text.trimEnd().endsWith("在指定表面上对照判据判 pass/fail 并带证据；不验自己写判据的任务；FAIL 要说清缺什么。")).toBe(true);
    text = await (await fetch(`${base}/manual/qa`)).text();
    expect(text).toContain("这个项目没有为 qa 声明任何职责");
    // the page lists what nobody holds, in the dig layer, and nothing goes to 需要你
    const page = await (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
    expect(page).toContain('<section id="coverage"><h3>没人管的事');
    expect(page).toMatch(/<p class="meta team">团队：职责 \d+ 项：\d+ 有人/); // pd review of t-059: the 团队 line counts coverage first
    expect(page).toContain("<li>没人管把人的话变成要求：没有角色声明</li>");
    expect(page).toContain("<li>没人管做：dev 声明了但没在场</li>");
    expect(page).toContain("<li>没人管定方向：pm 声明了但没在场</li>"); // pm holds R1 but has not pulled (writing is not listening)
  });
});

describe("t-066 · the manual says how to write an instruction to the human", () => {
  it("the common part and the pm part both carry the rule: first sentence is an action or a question, 30 chars, self-contained; options with a default", async () => {
    for (const path of ["/manual/dev", "/manual/pm"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      expect(text).toContain("第一句就是全部");
      expect(text).toContain("不超过 30 字");
      expect(text).toContain("脱离上下文也能读懂");
      expect(text).toContain("--default");
      for (const re of OVERFIT) expect(text, `${path} leaks ${re}`).not.toMatch(re);
    }
    const pm = await (await fetch(`${base}/manual/pm`)).text();
    expect(pm.split("第一句就是全部").length).toBe(3); // once in the common part, once in pm's own
  });
});

describe("t-081 · any declared role has a manual, assembled from its responsibilities", () => {
  const post = (actor: string, body: unknown) => fetch(`${base}/events`, { method: "POST", headers: { authorization: "Bearer secret", "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (role: string) => fetch(`${base}/manual/${encodeURIComponent(role)}`);
  it("names this repository never heard of work once declared, their content follows the ids, and an undeclared name is still 404", async () => {
    expect((await get("release-manager")).status).toBe(404);
    expect((await (await get("release-manager")).json()).message).toContain("project:roles");
    expect((await post("pm", { kind: "reading", surface: "project", key: "roles", value: { pm: ["R1", "R4"], be: ["R5", "R9"], fe: ["R5"], "release-manager": ["R9"], "ux-scanner": ["R12"] } })).status).toBe(201);
    for (const [role, must, mustNot] of [
      ["be", ["R5 做", "R9 上线", "claim 时把触点写宽"], ["R12"]],
      ["release-manager", ["R9 上线", "推之前确认自己有许可和凭据"], ["R5 做"]],
      ["ux-scanner", ["R12 看着跑起来的东西说哪里不对", "把观察写成 note 带证据"], ["R9"]],
    ] as const) {
      const text = await (await get(role)).text();
      expect((await get(role)).status).toBe(200);
      expect(text).toContain("# 说明书 · 通用核心"); // the common core, whatever the role is called
      expect(text).toContain(`# 角色 · ${role}`);
      for (const s of must) expect(text, `${role} lacks ${s}`).toContain(s);
      for (const s of mustNot) expect(text, `${role} should not carry ${s}`).not.toContain(s);
      for (const re of OVERFIT) expect(text, `${role} leaks ${re}`).not.toMatch(re);
    }
    // the five this repository ships with keep their written part, plus their declared responsibilities
    const pm = await (await get("pm")).text();
    expect(pm).toContain("# 角色 · pm");
    expect(pm).toContain("- **R1 定方向**：");
    expect(pm).not.toContain("R3 定验收标准"); // this project declared pm without R3 above
    // a name nobody declared: still nothing
    expect((await get("nobody")).status).toBe(404);
  });
});

describe("t-082 · the manual says how the first node declares the role set", () => {
  it("the newcomer's manual and pm's both show the {role: [ids]} form, say the ids come from the service, and stay project-neutral", async () => {
    const welcome = await (await fetch(`${base}/manual`)).text();
    const pm = await (await fetch(`${base}/manual/pm`)).text();
    for (const [name, text] of [["welcome", welcome], ["pm", pm]] as const) {
      expect(text, name).toContain(`"key":"roles"`.replace(/"/g, name === "welcome" ? '"' : '"')?.slice(0, 0) + "roles");
      expect(text, name).toMatch(/\{"?[^"]*"?:\s*\[/); // the {role: [ids]} form, spelled out
      expect(text, name).toContain("R5");
      expect(text, name).toContain("R5:后端"); // pd 23:01: two roles on one responsibility must say where the boundary is
      expect(text, name).toContain("分界");
      expect(text, name).toContain("默认");  // what happens when nobody declares
      for (const re of OVERFIT) expect(text, `${name} leaks ${re}`).not.toMatch(re);
    }
    expect(welcome).toContain("职责 id 的全表由服务下发");
    expect(pm).toContain("职责 id 的全表在每个角色说明书末尾");
  });
});

describe("t-090 · the 搬家 section, and every name in it really exists", () => {
  /** The section as the service serves it, for any role. */
  const section = (text: string) => {
    const start = text.indexOf("## 搬家");
    expect(start, "the manual has no 搬家 section").toBeGreaterThan(-1);
    const rest = text.slice(start + 3);
    const end = rest.indexOf("\n## ");
    return rest.slice(0, end === -1 ? undefined : end);
  };

  it("says the four rules, does not describe the old format, and is there for every declared role", async () => {
    const text = await (await fetch(`${base}/manual/dev`)).text();
    const s = section(text);
    for (const rule of ["只搬在途", "不搬历史", "每条都带 `from`", "先放核对卡", "邀请发回旧渠道"]) expect(s, rule).toContain(rule);
    expect(s).toContain("读旧单据永远是你的事"); // criterion 2: reading the old records is the agent's, not ours
    expect(s).toContain("不规定旧东西长什么样");
    expect(s).toContain("他回答之前，不要动旧渠道");
    // criterion 4: assembled the same way for a role this repository never heard of
    await fetch(`${base}/events`, { method: "POST", headers: { authorization: "Bearer secret", "x-actor": "pm", "content-type": "application/json" }, body: JSON.stringify({ kind: "reading", surface: "project", key: "roles", value: { pm: ["R1"], "release-manager": ["R9"] } }) });
    const other = await (await fetch(`${base}/manual/release-manager`)).text();
    expect(section(other)).toBe(s);
    for (const re of OVERFIT) expect(s, `搬家 leaks ${re}`).not.toMatch(re);
  });

  it("every field and command it names exists in the code today: writing something unimplemented turns this red", async () => {
    const s = section(await (await fetch(`${base}/manual/dev`)).text());
    const root = new URL("../../", import.meta.url); // packages/
    const src = ["core/src/events.ts", "core/src/rules.ts", "core/src/reduce.ts", "core/src/board.ts", "cli/src/main.ts", "server/src/app.ts"]
      .map((f) => readFileSync(new URL(f, root), "utf8")).join("\n");
    // every backticked token, plus every JSON key in the commands the section shows: both are names it promises exist
    const keys = [...s.matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]);
    const names = [...new Set([...[...s.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]), ...keys])]
      .flatMap((token) => {
        if (/^(curl|#|\{|-)/.test(token) || token.includes(" ") === false && /^[a-z_]+$/i.test(token)) return [token];
        const m = /^([a-z_]+):\s*"?([a-z_]+)"?$/i.exec(token); // `intent: "ask"` → both halves
        return m ? [m[1], m[2]] : [];
      })
      .filter((t) => /^[a-z_]+$/i.test(t) && t.length > 1);
    expect(names.length, "the section names nothing checkable").toBeGreaterThan(8);
    for (const name of names) {
      expect(src.includes(name), `the 搬家 section names "${name}", which nothing in core/cli/server implements`).toBe(true);
    }
    // the three the whole section rests on, spelled out so a rename cannot pass silently
    for (const must of ["from", "measured_at", "supersedes", "options", "default", "criteria", "touches", "evidence"]) expect(names, must).toContain(must);
  });
});
