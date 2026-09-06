/**
 * t-004: identity persists across calls. `ateam init --me <role>` is enough when the server and token are in the env.
 */
import { describe, it, expect } from "vitest";
import { resolveConfig, initFields } from "../src/config.js";

describe("t-004 · ateam init --me works from env", () => {
  it("init with --url omitted writes only the given fields", () => {
    expect(initFields({ me: "qa" }, { ATEAM_URL: "https://ateam.fly.dev", ATEAM_TOKEN: "t" })).toEqual({ me: "qa" });
    expect(initFields({ me: "qa", url: "http://localhost:8080" }, {})).toEqual({ me: "qa", url: "http://localhost:8080" });
    expect(initFields({ me: "qa", url: "http://x", token: "s" }, {})).toEqual({ me: "qa", url: "http://x", token: "s" });
  });

  it("init refuses when there is no server anywhere, or no --me", () => {
    expect(() => initFields({ me: "qa" }, {})).toThrow(/--url <server> or set ATEAM_URL/);
    expect(() => initFields({ url: "http://x" }, { ATEAM_ME: "qa" })).toThrow(/--me <role> is required/);
  });

  it("after init, a fresh shell with ATEAM_ME unset resolves identity from the file and the rest from env", () => {
    const cfg = resolveConfig({ me: "qa" }, { ATEAM_URL: "https://ateam.fly.dev", ATEAM_TOKEN: "secret" });
    expect(cfg).toEqual({ url: "https://ateam.fly.dev", me: "qa", token: "secret" });
    // env identity wins over the file, so a shared checkout can still be used as someone else
    expect(resolveConfig({ me: "qa", url: "http://file" }, { ATEAM_ME: "human", ATEAM_URL: "" }).me).toBe("human");
    expect(resolveConfig({ me: "qa", url: "http://file" }, { ATEAM_ME: "human" }).url).toBe("http://file");
  });

  it("with neither --me nor ATEAM_ME nor config, the error names both ways to set identity", () => {
    expect(() => resolveConfig({}, { ATEAM_URL: "http://x" })).toThrow(/ateam init --me <role>.*export ATEAM_ME=<role>/);
    expect(() => resolveConfig({}, {})).toThrow(/ATEAM_ME.*ATEAM_URL/s);
  });
});
