/**
 * t-083 (wording) and t-091 (the standing line): the LIVE block names who pushed and who checked, and says how many
 * verified tasks are waiting for a deploy — from the same counts the board reads (t-078), never recomputed here.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";

async function liveBlock(events: NewEvent[]) {
  const store = new MemoryStore();
  let t = Date.now() - 3_600_000;
  for (const e of events) await append(store, e as never, { human: HUMAN, now: new Date((t += 60_000)) });
  const state = reduce(await store.read());
  return fmt.board(board(state, HUMAN), "qa").split("\n").filter((l) => l.startsWith("LIVE") || l.startsWith("           ")).join("\n");
}

const sha = (value: string, method?: string): NewEvent => ({ kind: "reading", actor: "qa", surface: "production", key: "deployed.sha", value, method } as NewEvent);
const done = (id: string): NewEvent[] => [
  { kind: "task", op: "create", actor: "pm", task: id, title: `任务 ${id}`, criteria: ["可用"] },
  { kind: "task", op: "claim", actor: "dev", task: id, touches: [`src/${id}.ts`] },
  { kind: "task", op: "done", actor: "dev", task: id, evidence: `1111111: 全绿` },
  { kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true, evidence: "测试通过" },
] as NewEvent[];

describe("t-083 · LIVE 行的署名", () => {
  it("says 核对 without 的 when someone measured which version is live", async () => {
    expect(await liveBlock([sha("aaaaaaa1111", "curl /health 读到的")])).toContain("(qa ");
    expect(await liveBlock([sha("aaaaaaa1111", "curl /health 读到的")])).toContain("核对)");
    expect(await liveBlock([sha("aaaaaaa1111", "curl /health 读到的")])).not.toContain("核对的");
  });

  it("says 推的 when that person's own release --deploy wrote the fact, and neither when the fact does not say", async () => {
    expect(await liveBlock([sha("bbbbbbb2222", "ateam release --deploy 推的")])).toContain("推的)");
    const silent = await liveBlock([sha("ccccccc3333")]);
    expect(silent).toContain("production ccccccc");
    expect(silent).not.toContain("推的");
    expect(silent).not.toContain("核对");
  });
});

describe("t-091 · LIVE 下的待部署一句", () => {
  it("says how many wait, says why when it cannot tell, and says nothing when none wait", async () => {
    const base = [sha("aaaaaaa1111", "读 /health"), ...done("t-1"), ...done("t-2")];
    const fact = (contained: string[], not_contained: string[]): NewEvent => ({ kind: "reading", actor: "dev", surface: "production", key: "deployed.tasks", value: { sha: "aaaaaaa1111", contained, not_contained }, method: "ateam release 用 git 逐件测" } as NewEvent);

    const cannotTell = await liveBlock(base);
    expect(cannotTell).toContain("不知道有多少件在等上线");

    expect(await liveBlock([...base, fact(["t-1"], ["t-2"])])).toContain("1 件验过了，等一次上线。");

    const none = await liveBlock([...base, fact(["t-1", "t-2"], [])]);
    expect(none).not.toContain("等一次上线");
    expect(none).not.toContain("0 件");
  });
});
