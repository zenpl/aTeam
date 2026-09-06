/**
 * t-023: a stray positional argument is refused and echoed, never folded silently into a title or body.
 */
import { describe, it, expect } from "vitest";
import { exact, UsageError, parse } from "../src/args.js";
import * as fmt from "../src/format.js";

describe("t-023 · exact positionals", () => {
  it("returns exactly the named positionals", () => {
    expect(exact(["t-1", "标题"], "id", "title")).toEqual(["t-1", "标题"]);
    expect(exact([])).toEqual([]);
  });

  it("refuses extras with exit-2 usage error that echoes every argument received", () => {
    let err: unknown;
    try { exact(["t-1", "服务器", "报告", "sha"], "id", "title"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    const msg = (err as Error).message;
    expect(msg).toContain("expected <id> <title>, got 4:");
    expect(msg).toContain('1. "t-1"');
    expect(msg).toContain('2. "服务器"');
    expect(msg).toContain('3. "报告"');
    expect(msg).toContain('4. "sha"');
    expect(msg).toContain("Nothing was sent");
    expect(() => exact(["extra"])).toThrow(/expected no positional arguments, got 1/);
  });

  it("still names a missing positional", () => {
    expect(() => exact(["pm"], "to", "body")).toThrow(/missing <body>/);
    expect(() => exact(["pm", "  "], "to", "body")).toThrow(/missing <body>/);
  });

  it("flags never count as positionals", () => {
    const a = parse(["task", "create", "t-1", "标题", "--criteria", "判据一", "--criteria", "判据二"]);
    expect(a._).toEqual(["task", "create", "t-1", "标题"]);
    expect(a.flags.criteria).toEqual(["判据一", "判据二"]);
  });
});

describe("t-023 · task create echoes what was sent", () => {
  it("prints the title and numbered criteria", () => {
    expect(fmt.created("服务器报告部署的 sha", ["GET /health 返回 sha", "缺 sha 时显示 unknown"])).toBe(
      "  title: 服务器报告部署的 sha\n  1. GET /health 返回 sha\n  2. 缺 sha 时显示 unknown");
  });
});
