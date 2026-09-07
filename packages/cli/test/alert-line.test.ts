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
