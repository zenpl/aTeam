/**
 * t-039: `ateam join --me <role>` writes the config, syncs once, prints the manual, and ends with where the project file is.
 */
import { describe, it, expect } from "vitest";
import { initFields, joinOutput, JOIN_FOOTER } from "../src/config.js";
import { parse, str } from "../src/args.js";

describe("t-039 · ateam join", () => {
  it("takes the same fields as init and writes only what it was given", () => {
    const a = parse(["join", "--me", "writer"]);
    expect(a._).toEqual(["join"]);
    expect(initFields({ me: str(a, "me"), url: str(a, "url"), token: str(a, "token") }, { ATEAM_URL: "https://x", ATEAM_TOKEN: "k" })).toEqual({ me: "writer" });
    expect(initFields({ me: "qa", url: "https://x", token: "k" }, {})).toEqual({ me: "qa", url: "https://x", token: "k" });
  });

  it("prints the manual and always ends with the project-file hint", () => {
    const out = joinOutput("dev", "# 说明书 · 通用核心\n\n…\n\n# 角色 · dev\n\n做：…\n");
    expect(out.startsWith("# 说明书 · 通用核心")).toBe(true);
    expect(out.split("\n").at(-1)).toBe(JOIN_FOOTER);
    expect(out).toContain("docs/self.md");
  });

  it("says so when the server has no manual for the role, and still ends with the hint", () => {
    const out = joinOutput("writer", null);
    expect(out).toContain("没有 writer 这个角色的说明书");
    expect(out.split("\n").at(-1)).toBe(JOIN_FOOTER);
  });
});
