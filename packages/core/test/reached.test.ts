/**
 * t-134: t-119 stopped the board saying "已配置" because a string was there. It did not stop anyone *writing the
 * proof*. `project:alert.reached` records that a call-out actually landed — something only the service that made the
 * call can know — but nothing said so, so any node could write one naming the current address and the board would
 * promise the human "你不在时会发到这里". The same hole, entered through a different door.
 *
 * Two defences, either of which is enough on its own: the write is refused, and a proof written by anyone but the
 * service is not believed even if it is already in the log. All times relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, alertContact, reachedProof, Rejected, SERVICE_ACTOR, PROJECT_SURFACE, ALERT_REACHED_KEY, ALERT_WEBHOOK_KEY, type Event } from "../src/index.js";

const HUMAN = "human";
const AT = "https://hooks.example/team";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

const withAddress = async () => {
  const s = new MemoryStore();
  await append(s, { kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: ALERT_WEBHOOK_KEY, value: AT }, { human: HUMAN, now: at(0) });
  return s;
};
/** How alerts.ts records it: the service, after a call that actually landed. */
const serviceProof = (s: MemoryStore, value = AT, mins = 1) =>
  append(s, { kind: "reading", actor: SERVICE_ACTOR, surface: PROJECT_SURFACE, key: ALERT_REACHED_KEY, value, method: "外呼 all_missing 真的送到了（HTTP 200）" }, { human: HUMAN, now: at(mins) });

describe("t-134 · only the service can prove it reached anyone", () => {
  it("a node writing the proof is refused, and the refusal names the rule and the way out", async () => {
    const s = await withAddress();
    const err = await append(s, { kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: ALERT_REACHED_KEY, value: AT }, { human: HUMAN, now: at(1) }).catch((e: Rejected) => e);
    expect(err).toBeInstanceOf(Rejected);
    expect((err as Rejected).rule).toBe("alert.reached");
    expect((err as Rejected).message).toContain("只由服务自己写");
    expect((err as Rejected).message).toContain("还没真发成功过");        // where it stops instead: an existing state, not a new one
    expect((await s.read()).events).toHaveLength(1);                      // nothing written
  });

  it("the board does not promise anything on a proof a node wrote, even one already in the log", async () => {
    const s = await withAddress();
    // written before this rule existed — history is not rewritten, so the board has to be able to disbelieve it
    await s.appendRaw({ id: "01FORGED", at: at(1).toISOString(), kind: "reading", actor: "qa", surface: PROJECT_SURFACE, key: ALERT_REACHED_KEY, value: AT, method: "我说它通了" } as Event);
    const a = alertContact(reduce(await s.read(), at(2)), at(2));
    expect(a.status).toBe("unproven");                                    // t-119's four states, no fifth one
    expect(a.line).toBe("记下了外呼地址，还没真发成功过——不知道你收不收得到。");
    expect(a.line).not.toContain("会发到这里");
    expect(reachedProof(reduce(await s.read(), at(2)))).toBeNull();
  });

  it("the service's own proof is believed, and a node cannot write over it to take it away", async () => {
    const s = await withAddress();
    await serviceProof(s);
    expect(alertContact(reduce(await s.read(), at(2)), at(2)).status).toBe("reachable");
    // a later reading by someone else supersedes it in the log; the proof is still the service's newest one
    await s.appendRaw({ id: "01LATER", at: at(3).toISOString(), kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: ALERT_REACHED_KEY, value: "https://hooks.example/other", method: "换个地址" } as Event);
    const a = alertContact(reduce(await s.read(), at(4)), at(4));
    expect(a.status).toBe("reachable");
    expect(reachedProof(reduce(await s.read(), at(4)))!.value).toBe(AT);
  });

  it("the human's 现在试一下 is the same rule: whoever presses it does not get to write the answer", async () => {
    const s = await withAddress();
    // the human pressing a button is still not the one who made the call
    await expect(append(s, { kind: "reading", actor: HUMAN, surface: PROJECT_SURFACE, key: ALERT_REACHED_KEY, value: AT }, { human: HUMAN, now: at(1) })).rejects.toThrow(Rejected);
    expect(alertContact(reduce(await s.read(), at(2)), at(2)).status).toBe("unproven");
    // the service trying it and landing is what moves it, whatever set the attempt off
    await serviceProof(s, AT, 2);
    expect(alertContact(reduce(await s.read(), at(3)), at(3)).status).toBe("reachable");
  });

  it("the board's own summary never says 会发到这里 on a forged proof", async () => {
    const s = await withAddress();
    await s.appendRaw({ id: "01FORGED2", at: at(1).toISOString(), kind: "reading", actor: "frontend", surface: PROJECT_SURFACE, key: ALERT_REACHED_KEY, value: AT } as Event);
    const b = board(reduce(await s.read(), at(2)), HUMAN, at(2));
    expect(b.alert!.line).not.toContain("会发到这里");
    expect(JSON.stringify(b)).not.toContain("最近一次成功是");
  });
});
