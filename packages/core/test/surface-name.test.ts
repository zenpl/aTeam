/**
 * t-213：表面名散在 12 处裸字面量里，HUMAN_SURFACE 只是个摆设。
 *
 * 判据 2 要的是一道闸：**改一处漏一处必须有东西会红**，不能靠人逐个找。这份用例先证那道闸真的会红（否则它只是
 * 一句自我描述），再证收拢之后它是绿的，最后把它看不见的三件事各钉一个用例——**盲区是会红的用例，不是注释**。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles, bareSurfaceLiterals, isProductSource, SECOND_HOMES_ROOT, SURFACE_GATE_BLIND_SPOTS, SURFACES, HUMAN_SURFACE } from "../src/index.js";

const ROOT = join(import.meta.dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
/**
 * t-185：**范围是走出来的，不是名单。** 从 packages 走到每一个产品源码文件——新加一个文件、新加一个包，它当场
 * 就在范围里。这里原来写死了三个目录；那正是今晚已经付过账的那个形状。
 */
const sources = () => sourceFiles(join(ROOT, SECOND_HOMES_ROOT), SECOND_HOMES_ROOT).filter(isProductSource);
const scan = () => sources().flatMap((f) => bareSurfaceLiterals(read(f)).map((h) => `${f}:${h.line}  ${h.text}`));

describe("t-213 判据 1、2 · 表面位置上不许有裸的表面名", () => {
  it("产品代码里一处都没有", () => {
    const found = scan();
    expect(found, `表面位置上还有 ${found.length} 处裸的表面名，收拢到 HUMAN_SURFACE（或对应的表面常量）：\n${found.join("\n")}`).toEqual([]);
  });

  it("闸真的会红：把一处改回裸字面量，它当场点名（不是自我描述）", () => {
    // 这三种写法今晚都在仓库里真出现过，逐种证一遍
    expect(bareSurfaceLiterals(`x.filter((r) => r.surface === "production" && r.pass)`)).toHaveLength(1);
    expect(bareSurfaceLiterals(`{ surface: "production", key: DEPLOYED_TASKS_KEY }`)).toHaveLength(1);
    expect(bareSurfaceLiterals(`t.verified_on.includes("production")`)).toHaveLength(1);
    expect(bareSurfaceLiterals(`if (r.surface !== "repo") return;`)).toHaveLength(1);
    expect(bareSurfaceLiterals(`if ("production" === r.surface) return;`)).toHaveLength(1);
    // 行号说得出来，否则「有一处」等于没说
    expect(bareSurfaceLiterals(`a\nb\nconst v = x.surface === "staging";`)[0]).toMatchObject({ line: 3 });
  });

  it("不是见字就抓：同一个字还可能是推送等级或分支名，收拢那些是错的", () => {
    expect(bareSurfaceLiterals(`export const PUSH_LEVELS = ["none", "own-branch", "integration", "production"] as const;`)).toEqual([]);
    expect(bareSurfaceLiterals(`branch: typeof o.branch === "string" && o.branch ? o.branch : "production",`)).toEqual([]);
    expect(bareSurfaceLiterals(`if (pushLevelOf(s, role) === "production") return;`)).toEqual([]);
    // 声明本身也配不到——例外是构造出来的，不是一份「这一处放过」的名单
    expect(bareSurfaceLiterals(`export const HUMAN_SURFACE = "production";`)).toEqual([]);
    expect(bareSurfaceLiterals(`export const SURFACES = ["repo", "staging", "production"] as const;`)).toEqual([]);
  });
});

describe("t-213 判据 2 · 闸看不见的三件事，每件一个会红的用例", () => {
  it("① 经变量绕一手：闸配不到", () => {
    expect(bareSurfaceLiterals(`const s = "production";\nif (r.surface === s) return;`)).toEqual([]);
  });

  it("② 按位置传的表面名：闸看不出第三个参数是个表面", () => {
    expect(bareSurfaceLiterals(`await b.task.verify("qa", "t-1", "repo", false, {});`)).toEqual([]);
  });

  it("③ 默认值写法：确实是表面位置，但引号前面不是那个字段名", () => {
    expect(bareSurfaceLiterals(`surface: opts.surface ?? "repo",`)).toEqual([]);
  });

  it("三条盲区写在代码里、和用例一一对上——名单与被描述的东西分开维护就会漂", () => {
    expect(SURFACE_GATE_BLIND_SPOTS).toHaveLength(3);
    for (const s of SURFACE_GATE_BLIND_SPOTS) expect(s.length).toBeGreaterThan(10);
  });
});

describe("t-213 · HUMAN_SURFACE 不再是摆设", () => {
  it("它就是 SURFACES 里的一个，不是另写的一个字", () => {
    expect(SURFACES).toContain(HUMAN_SURFACE);
  });

  it("产品代码里真的有人读它——这正是它今天没有的那一条", () => {
    const readers = sources()
      .filter((f) => f !== "packages/core/src/events.ts")
      .filter((f) => /\bHUMAN_SURFACE\b/.test(read(f)));
    expect(readers.length, "没有一个产品文件读 HUMAN_SURFACE：那它就还是个摆设").toBeGreaterThan(0);
  });
});

describe("t-213 · 闸的范围是走出来的，不是名单", () => {
  it("走到了每一个包的每一个源码文件，不是写死的三个目录", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(30);
    for (const pkg of ["core", "cli", "server"]) expect(files.some((f) => f.startsWith(`packages/${pkg}/src/`))).toBe(true);
    // 测试文件不在范围里：用例里写 "production" 是在造样本，不是在判表面
    expect(files.some((f) => /\.test\.ts$/.test(f))).toBe(false);
  });

  it("新加一个包、新加一个文件都当场在范围里（按位置判，不按名字）", () => {
    expect(isProductSource("packages/一个还不存在的包/src/x.ts")).toBe(true);
    expect(isProductSource("packages/core/src/deep/nested/y.ts")).toBe(true);
    expect(isProductSource("packages/core/test/x.test.ts")).toBe(false);
    expect(isProductSource("packages/core/src/x.test.ts")).toBe(false);
    expect(isProductSource("packages/core/dist/x.js")).toBe(false);
    expect(isProductSource("bin/ateam")).toBe(false);
  });
});
