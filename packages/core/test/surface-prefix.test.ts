/**
 * t-127 (M4): a reading whose key repeats its own surface lands as project:project:roles. Nothing that reads
 * project:roles will ever see it, and — the part that makes it worth a rule — it looks like it worked: 201 back, a row
 * in the log, no consumer. pm wrote one that way and it was invisible until someone went looking for it.
 *
 * The rule refuses the second saying of the surface. It does not refuse colons: node:release:能力 is a real key.
 * All times relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, Rejected, capabilityKey } from "../src/index.js";

const HUMAN = "human";
const store = () => new MemoryStore();
const put = (s: MemoryStore, surface: string, key: string, value: unknown) =>
  append(s, { kind: "reading", actor: "pm", surface, key, value }, { human: HUMAN });

describe("t-127 · a key does not say its surface twice", () => {
  it("refuses it, names the rule, and prints what to write instead", async () => {
    const s = store();
    await expect(put(s, "project", "project:roles", ["pm", "dev"])).rejects.toThrow(Rejected);
    const err = await put(s, "project", "project:roles", ["pm", "dev"]).catch((e: Rejected) => e);
    expect((err as Rejected).rule).toBe("reading");
    expect((err as Rejected).message).toContain("project:project:roles");   // what it would have landed as
    expect((err as Rejected).message).toContain("--surface project <键> roles"); // and what to write
    expect((await store().read()).events).toHaveLength(0);
  });

  it("the same on every other surface, not just project", async () => {
    for (const [surface, key, value] of [["production", "deployed.sha", "abc1234"], ["repo", "append.ms", 0.17], ["staging", "rows", 12]] as const) {
      const s = store();
      await expect(put(s, surface, `${surface}:${key}`, value)).rejects.toThrow(new RegExp(`${surface}:${surface}:${key}`));
      expect((await put(s, surface, key, value)).id).toBeTruthy();          // the right way still works
    }
  });

  it("a colon in a key is not the mistake: node:release:能力 is a real key and still writes", async () => {
    const s = store();
    const e = await append(s, { kind: "reading", actor: "release", surface: "node", key: capabilityKey("release"), value: ["R9"] }, { human: HUMAN });
    expect(reduce(await s.read()).latestReading.get(`node:${capabilityKey("release")}`)).toBe(e.id);
    // and a key that merely starts with another surface's name is nobody's business here
    expect((await put(s, "repo", "project.notes", 3)).id).toBeTruthy();
  });

  it("the one already in the log stays exactly where it is: nothing is migrated, no id changes", async () => {
    const s = store();
    // written before the rule existed — appendRaw is how history gets in, and history is not rewritten
    const before: Parameters<MemoryStore["appendRaw"]>[0] = { id: "01OLD", at: new Date(Date.now() - 60_000).toISOString(), kind: "reading", actor: "pm", surface: "project", key: "project:roles", value: ["pm"] };
    await s.appendRaw(before);
    const st = reduce(await s.read());
    expect(st.latestReading.get("project:project:roles")).toBe("01OLD");    // still there, still readable, id untouched
    await expect(put(s, "project", "project:roles", ["pm"])).rejects.toThrow(Rejected);   // but never a second one
  });
});
