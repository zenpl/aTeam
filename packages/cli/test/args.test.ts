/**
 * t-023: a stray positional argument is refused and echoed, never folded silently into a title or body.
 */
import { describe, it, expect } from "vitest";
import { exact, UsageError, parse, list, measuredAtOf } from "../src/args.js";
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

describe("t-051 · --measured-at", () => {
  it("takes an ISO time or how long ago, and refuses anything else", () => {
    const now = new Date(1_700_000_000_000);
    expect(measuredAtOf("10m", now)).toBe(new Date(now.getTime() - 600_000).toISOString());
    expect(measuredAtOf("2h", now)).toBe(new Date(now.getTime() - 7_200_000).toISOString());
    expect(measuredAtOf(new Date(now.getTime() - 5000).toISOString(), now)).toBe(new Date(now.getTime() - 5000).toISOString());
    expect(() => measuredAtOf("yesterday", now)).toThrow(UsageError);
  });
});

/**
 * t-173：三个开关今天是死的，其中一个是 t-151 那道闸唯一的出路。三种症状各一条，qa 08:33 报的第三种最坏。
 */
describe("t-173 · 布尔开关必须真的设得上", () => {
  it("单写开关就能设上（原来报 needs a value）", () => {
    expect(parse(["task", "done", "t-1", "--no-human-impact"]).flags["no-human-impact"]).toBe(true);
    expect(parse(["task", "seam", "a", "b", "--missed"]).flags.missed).toBe(true);
    expect(parse(["sync", "--clear-refused"]).flags["clear-refused"]).toBe(true);
  });

  it("写成 --x true 也不会变成字符串（原来 bool() 仍然返回 false）", () => {
    const f = parse(["task", "done", "t-1", "--no-human-impact", "true"]).flags;
    expect(f["no-human-impact"]).toBe(true);
    expect(f["no-human-impact"]).not.toBe("true");
  });

  it("qa 08:33 报的第三种、也是最坏的一种：它不再把后面那个开关当值吞掉", () => {
    const f = parse(["task", "done", "t-1", "--no-human-impact", "--evidence", "abc1234"]).flags;
    expect(f["no-human-impact"]).toBe(true);
    expect(f.evidence).toBe("abc1234");   // 原来 evidence 静默丢失，不报错
  });
});

/**
 * t-197 判据 2：**重复给不再静默覆盖。**
 *
 * 漏一个开关时的症状最安静：`--refs a --refs b` 不报错、不重复，后一个盖掉前一个，命令照常成功。所以这里
 * 一正一反地钉住每一个：给两次两个都落，给一次落一个。
 */
describe("t-197 · 可重复的参数给几次落几个", () => {
  for (const flag of ["refs", "touches", "writes", "depends-on", "enum", "criteria", "assumes", "option", "internal-only"]) {
    it(`--${flag} 给两个，两个都在`, () => {
      const a = parse([`--${flag}`, "一", `--${flag}`, "二"]);
      expect(list(a, flag), `--${flag} 给两次只落了一个：后一个静默盖掉了前一个`).toEqual(["一", "二"]);
    });
    it(`--${flag} 给一个，就落一个`, () => {
      expect(list(parse([`--${flag}`, "一"]), flag)).toEqual(["一"]);
    });
  }
});

/**
 * t-194：**sync 打给本人的那几行要带得出指令 id。**
 *
 * ack 退役的时候，「怎么引用它」和「催你 ack」是一起被删掉的——于是 t-193 之后新口径要求的东西（引用它才算
 * 办了），界面不再提供。pm 11:05 攒下 15 条「读过还没动」，每一条都真的动过；两次想用 `--refs` 回话都因为手边
 * 没有 id 而失败，编出来的 id 被服务当场拒。
 */
describe("t-194 · 给本人的行带得出 id，别人的不带", () => {
  const inst = (to: string, options?: string[]) => ({
    id: "01M1XVDXXXXXXXXXXXXXXXXXXX", at: new Date().toISOString(), kind: "instruction",
    actor: "pm", to, body: "去看一眼 CI", ack_by: new Date().toISOString(), ...(options ? { options } : {}),
  }) as never;

  it("判据 1、3 正例：给我的不带选项那种，打出可以直接抄的引用写法", () => {
    const line = fmt.event(inst("dev"), "dev");
    expect(line).toContain("⇐ FOR YOU");
    expect(line, "标了「给你的」却一个 id 都不给——那正是 t-194 这件事").toContain("--refs 01M1XVDXXXXXXXXXXXXXXXXXXX");
  });

  it("带选项的那种照旧给它自己的写法，两种都给得出 id", () => {
    const line = fmt.event(inst("dev", ["A", "B"]), "dev");
    expect(line).toContain("ateam decide 01M1XVDXXXXXXXXXXXXXXXXXXX <option>");
  });

  it("判据 3 反例：不是给我的，一个 id 都不打——别把别人的账摊给他看", () => {
    const line = fmt.event(inst("qa"), "dev");
    expect(line).not.toContain("FOR YOU");
    expect(line).not.toContain("--refs");
    expect(line).not.toContain("01M1XVDXXXXXXXXXXXXXXXXXXX");
  });
});

/**
 * t-197 之后我自己踩到的回归：把 `touches` 加进 REPEATABLE 之后，`--touches "a,b,c"` 走数组那一支，**逗号不再
 * 拆**——那一整串被当成一个触点存进日志（我 12:15 那次 claim 就是这么记下的），而说明书与 --help 教的正是
 * `--touches a,b`。两种写法都得成立，混着用也得成立。
 */
describe("t-197 续 · 可重复的参数里，逗号照拆", () => {
  it("一段带逗号的：拆开", () => {
    expect(list(parse(["--touches", "a.ts,b.ts,c.ts"]), "touches")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
  it("给两次、每段又带逗号：全拆开，一个不丢", () => {
    expect(list(parse(["--touches", "a.ts,b.ts", "--touches", "c.ts"]), "touches")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
  it("空段与空白照旧丢掉，不产生空触点", () => {
    expect(list(parse(["--refs", "x, ,y,"]), "refs")).toEqual(["x", "y"]);
  });
});
