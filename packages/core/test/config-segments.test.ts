/**
 * t-325 判据⑥⑦（pm 11:09 定稿 `01M68TAY8BCHQKZE6W79T29HJH`；粒度那个成因出自 frontend 的 note
 * `01M68T95X5S538MDD2R4Q8RJPC`）：**比树时许可的是「一处差异落在哪一段」，不是「一个文件」。**
 *
 * 真样本是今天的生产头：`fly.toml` 与第 20 批只差一行，而那一行在 `[[vm]]` 里（`memory` 256mb → 1gb）。
 * 同一个文件里的 `[build]`（dockerfile）与 `[env]` 能改镜像与运行环境——**按路径把整个文件豁免掉，
 * 就会把没在跑的代码报成在跑**，而那正是这张单要修的方向。
 */
import { describe, it, expect } from "vitest";
import { sectionAt, changesAllowed, ALLOWED_CONFIG_SEGMENTS } from "../src/index.js";

/** 今天生产那份 fly.toml 的形状（删掉无关行）。 */
const FLY = [
  'app = "ateam"',                 // 1
  'primary_region = "sin"',        // 2
  '',                              // 3
  '[build]',                       // 4
  '  dockerfile = "Dockerfile"',   // 5
  '',                              // 6
  '[env]',                         // 7
  '  ATEAM_HUMAN = "human"',       // 8
  '',                              // 9
  '[[vm]]',                        // 10
  '  size = "shared-cpu-1x"',      // 11
  '  memory = "1gb"',              // 12
].join("\n");

describe("t-325 判据⑥ · 一处差异落在哪一段", () => {
  it("段头从改动那一行往上找最近的一个", () => {
    expect(sectionAt(FLY, 12), "memory 那一行在 [[vm]] 里").toBe("[[vm]]");
    expect(sectionAt(FLY, 5), "dockerfile 那一行在 [build] 里").toBe("[build]");
    expect(sectionAt(FLY, 8)).toBe("[env]");
    expect(sectionAt(FLY, 1), "段头之前的顶层键：**判不出**，不是「没有段」").toBeNull();
  });

  it("**许可的那一段**：只有 `[[vm]]` 变 ⇒ 算应用内容相同，并说出排除了哪一段", () => {
    const v = changesAllowed([{ file: "fly.toml", content: FLY, lines: [12] }]);
    expect(v.ok).toBe(true);
    expect(v.excluded).toEqual([{ file: "fly.toml", section: "[[vm]]" }]);
  });

  it("**危险那一侧**：`[build]` 的 dockerfile 变了 ⇒ 不算相同（它能改镜像，也就是「跑的是哪一份代码」）", () => {
    const v = changesAllowed([{ file: "fly.toml", content: FLY, lines: [5] }]);
    expect(v.ok, "按路径豁免整个 fly.toml 会把这一格放过去——那就是把没在跑的报成在跑").toBe(false);
    expect(v.blocked).toEqual({ file: "fly.toml", section: "[build]" });
  });

  it("`[env]` 也不算：它改的是运行环境", () => {
    expect(changesAllowed([{ file: "fly.toml", content: FLY, lines: [8] }]).ok).toBe(false);
  });

  it("一处许可、一处不许可 ⇒ 整个说不出（不是「许可的那部分算」）", () => {
    const v = changesAllowed([{ file: "fly.toml", content: FLY, lines: [12, 5] }]);
    expect(v.ok).toBe(false);
    expect(v.blocked?.section).toBe("[build]");
  });

  it("判不出的两种也不算：段头之前的顶层键、以及整个文件新增或删除（没有行号）", () => {
    expect(changesAllowed([{ file: "fly.toml", content: FLY, lines: [1] }]).blocked).toEqual({ file: "fly.toml", section: null });
    expect(changesAllowed([{ file: "fly.toml", content: "", lines: [] }]).blocked).toEqual({ file: "fly.toml", section: null });
  });

  it("别的文件里同名的段不算：许可是「哪个文件的哪一段」，不是「叫这个名字的段」", () => {
    expect(changesAllowed([{ file: "other.toml", content: FLY, lines: [12] }]).ok).toBe(false);
  });
});

describe("t-325 判据⑦ · 许可的段冻在一道会红的闸后面", () => {
  it("**此刻只有一条**：往里加一段，这一格就红，加的人要在证据里说出为什么", () => {
    expect(ALLOWED_CONFIG_SEGMENTS).toEqual([{ file: "fly.toml", section: "[[vm]]" }]);
    expect(ALLOWED_CONFIG_SEGMENTS, "数也钉住：加一条就红，不靠谁去读上面那一行").toHaveLength(1);
  });

  it("`[build]` 与 `[env]` 明确不在其中（判据⑥ 点名的那两个）", () => {
    for (const section of ["[build]", "[env]"])
      expect(ALLOWED_CONFIG_SEGMENTS.some((a) => a.section === section), `${section} 不许在许可名单里`).toBe(false);
  });
});
