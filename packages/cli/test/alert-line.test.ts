/**
 * t-126: `ateam board` says the same sentence the page does about whether a call-out can actually reach the human.
 * It used to print core's line only for 形状不对, so the state that matters most — an address recorded and never once
 * delivered to — read exactly like one that works: silence.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, SERVICE_ACTOR, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";

async function at(kind: "none" | "misconfigured" | "unproven" | "reachable") {
  const store = new MemoryStore();
  let t = Date.parse("2026-09-07T02:00:00.000Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 1000)) });
  const address = "https://hooks.example/team";
  if (kind === "misconfigured") await emit({ kind: "reading", actor: "pm", surface: "project", key: "alert.webhook", value: "me@example.com", shape: {} } as NewEvent);
  else if (kind !== "none") await emit({ kind: "reading", actor: "pm", surface: "project", key: "alert.webhook", value: address });
  // t-134: the proof is the service's own record of a call it made. Written by anyone else it is refused, and would
  // not be believed even if it were in the log.
  if (kind === "reachable") await emit({ kind: "reading", actor: SERVICE_ACTOR, surface: "project", key: "alert.reached", value: address, method: "外呼 全队停摆 真的送到了（HTTP 200）" });
  return board(reduce(await store.read()), HUMAN);
}

describe("t-126 · CLI 与牌桌说同一句", () => {
  it("prints core's sentence in every state that has one, not only 形状不对", async () => {
    const unproven = await at("unproven");
    expect(unproven.alert?.status).toBe("unproven");
    expect(fmt.board(unproven)).toContain(unproven.alert!.line!);
    expect(fmt.board(unproven)).toContain("还没真发成功过");
    // the promise it must never make about an address nothing has been delivered to
    expect(fmt.board(unproven)).not.toContain("你不在时发到");
    expect(fmt.board(unproven)).not.toContain("会发到这里");

    const reachable = await at("reachable");
    expect(reachable.alert?.status).toBe("reachable");
    expect(fmt.board(reachable)).toContain(reachable.alert!.line!);
    expect(fmt.board(reachable)).toContain("会发到这里");
  });

  it("says nothing extra when core has no sentence, and survives a board without alert at all", async () => {
    const none = await at("none");
    expect(none.alert?.line).toBeUndefined();
    expect(fmt.board(none)).not.toContain("还没真发成功过");
    // an older server sends no alert: the CLI must not throw or print a half line
    const old = { ...none, alert: undefined } as typeof none;
    const out = fmt.board(old);
    expect(out).not.toContain("undefined");
    expect(out).not.toMatch(/^ +$/m);
  });
});

describe("t-129 · CLI 也说得出这批为什么推不了", () => {
  it("prints core's sentence for a batch that cannot go out, and stays quiet for one that can", async () => {
    const store = new MemoryStore();
    let t = Date.parse("2026-09-07T04:00:00.000Z");
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 1000)) });
    await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" });
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "灰字", criteria: ["能用"] });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["src/a.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: "ccccccc3333：做完了" });
    await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks", value: { sha: "bbbbbbb2222", contained: ["t-1", "t-2"], not_contained: [], method: "逐件测" } });
    // packed on an older head, and it would take t-1/t-2 back off production
    await emit({ kind: "reading", actor: "release", surface: "repo", key: "batch.2.10", value: { sha: "eeeeeee5555", base: "aaaaaaa1111", contains: [] } });
    const b = board(reduce(await store.read()), HUMAN);
    const batch = b.batches.find((x) => x.name === "2.10")!;
    expect(batch.state).toBe("rollback");
    const out = fmt.board(b);
    // the same sentence the page shows: one source, no second wording (t-118's lesson)
    expect(out).toContain(batch.line);
    expect(out).toContain("2.10");

    // a batch packed on the current head has no warning to make, and the CLI says nothing about it
    await emit({ kind: "reading", actor: "release", surface: "repo", key: "batch.2.11", value: { sha: "fffffff6666", base: "bbbbbbb2222", contains: ["t-1"] } });
    const b2 = board(reduce(await store.read()), HUMAN);
    expect(b2.batches.find((x) => x.name === "2.11")!.line).toBe("");
    // it still appears as a reading like any other fact; what it must not have is a line warning about it
    expect(fmt.board(b2)).not.toMatch(/^\s+2\.11 \w+：/m);
    expect(fmt.board(b2)).toMatch(/^\s+2\.10 \w+：/m);
  });
});
