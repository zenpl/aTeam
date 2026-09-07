/**
 * t-139 (pd 05:15): overdue instructions split by whether whoever must answer is there.
 *
 * The three states do not add up to anything worth knowing. A role nobody is running needs a person to start one; a
 * node alive but no longer pulling needs to be listening again; a node that is listening and has not acked needs a
 * nudge. Tonight release was listening, producing steadily, and holding 22 unacked instructions, the oldest 160
 * minutes old — and it sat in the same heap as a genuinely absent role, which made the heap mean nothing.
 *
 * All times relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, missingCard, LISTEN_WINDOW_MS, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

/** A project where each role's last pull is set by hand, so all three states exist at once. */
async function world(pulls: Record<string, number | null>, tells: { to: string; mins: number }[]) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] }, -300);
  const ids: Record<string, string[]> = {};
  for (const t of tells) {
    const e = await put({ kind: "instruction", actor: "pm", to: t.to, body: `做一件事 ${t.to} ${t.mins}`, ack_by: at(t.mins + 1).toISOString() }, t.mins);
    (ids[t.to] ??= []).push(e.id);
  }
  for (const [actor, mins] of Object.entries(pulls)) {
    if (mins === null) continue;
    await s.setCursor({ actor, last_event_id: null, at: at(mins).toISOString() });
    // a node that pulls is also a node that speaks; a deaf one speaks without pulling
    await put({ kind: "note", actor, body: `${actor} 还在做事` }, mins);
  }
  return { s, ids, at: (m: number) => at(m) };
}

describe("t-139 · 逾期按在场三态分组", () => {
  it("tonight's scene: release listening with a pile, and an absent role — never the same heap", async () => {
    // release pulled a minute ago and is holding three overdue; qa has not pulled at all
    const w = await world({ release: -1, pm: -1 }, [
      ...Array.from({ length: 3 }, (_, i) => ({ to: "release", mins: -160 + i })),
      { to: "qa", mins: -200 },
    ]);
    const b = board(reduce(await w.s.read(), at(0)), HUMAN, at(0));
    const g = b.overdue_by_presence;
    expect(g.listening.roles).toEqual(["release"]);
    expect(g.listening.count).toBe(3);
    expect(g.listening.line).toBe("在听，3 条没确认");
    expect(g.listening.away_s).toBeNull();                    // it is here; how long it has been away is not a fact about it
    expect(g.missing.roles).toEqual(["qa"]);
    expect(g.missing.count).toBe(1);
    expect(g.missing.line).toBe("从没读过日志，1 条没送到");   // qa 06:07: qa has never pulled, so there is no duration to report
    expect(g.missing.away_s).toBeNull();
    // the two are never one number
    expect(g.listening.count + g.missing.count).toBe(b.overdue.length);
    expect(g.listening.instructions).not.toEqual(g.missing.instructions);
  });

  it("deaf is its own state: still talking, no longer pulling", async () => {
    // dev spoke a minute ago but its cursor is old; that is exactly deaf
    const w = await world({ dev: -1 }, [{ to: "dev", mins: -90 }]);
    await w.s.setCursor({ actor: "dev", last_event_id: null, at: at(-90).toISOString() });
    const b = board(reduce(await w.s.read(), at(0)), HUMAN, at(0));
    expect(b.presence.find((p) => p.actor === "dev")!.status).toBe("deaf");
    const g = b.overdue_by_presence;
    expect(g.deaf.roles).toEqual(["dev"]);
    expect(g.deaf.count).toBe(1);
    expect(g.deaf.line).toMatch(/^有 \d+ 分钟没读日志了，1 条没送到$/);   // pd 06:04: the verb we can actually observe
    expect(g.missing.count).toBe(0);
    expect(g.listening.count).toBe(0);
    expect(g.missing.line).toBe("");                          // an empty state says nothing rather than "0"
  });

  it("a listening recipient inside the window is listening, one second outside it is not", async () => {
    const inside = await world({ dev: -(LISTEN_WINDOW_MS / 60_000) + 0.5 }, [{ to: "dev", mins: -90 }]);
    expect(board(reduce(await inside.s.read(), at(0)), HUMAN, at(0)).overdue_by_presence.listening.count).toBe(1);
    const outside = await world({ dev: -(LISTEN_WINDOW_MS / 60_000) - 0.5 }, [{ to: "dev", mins: -90 }]);
    expect(board(reduce(await outside.s.read(), at(0)), HUMAN, at(0)).overdue_by_presence.listening.count).toBe(0);
  });

  it("nothing overdue: three empty groups, no sentences", async () => {
    const w = await world({ dev: -1 }, []);
    const g = board(reduce(await w.s.read(), at(0)), HUMAN, at(0)).overdue_by_presence;
    for (const k of ["missing", "deaf", "listening"] as const) {
      expect(g[k]).toEqual({ roles: [], count: 0, away_s: null, instructions: [], line: "" });
    }
  });

  it("the card the human gets says which state it is, and asks only what a human can do", () => {
    expect(missingCard("qa", "missing", 20, 2)).toBe("qa 缺人 20 分钟，2 条没送到。起一个 qa？");
    const deaf = missingCard("dev", "deaf", 40, 3);
    expect(deaf).toBe("dev 有 40 分钟没读日志了，3 条没送到——它还在写，只是没来读。起一个 dev？");
    // never read the log: no moment to count from, so neither side invents one (qa 06:07)
    expect(missingCard("qa", "missing", null, 1)).toBe("qa 从没读过日志，1 条没送到。起一个 qa？");
    expect(missingCard("dev", "deaf", null, 1)).toBe("dev 从没读过日志，1 条没送到——它还在写，只是没来读。起一个 dev？");
    for (const c of [missingCard("qa", "missing", null, 1), missingCard("dev", "deaf", null, 1)]) expect(c).not.toMatch(/\d+ 分钟/);
    // the difference is what is true, not a second instruction the human cannot carry out
    for (const card of [missingCard("qa", "missing", 20, 2), deaf]) expect(card).toContain("起一个");
    // the board is Chinese: the only Latin left is the role's own id, never an English word or a command name
    expect([...deaf.matchAll(/[A-Za-z][A-Za-z-]*/g)].map((m) => m[0])).toEqual(["dev", "dev"]);
  });
});
