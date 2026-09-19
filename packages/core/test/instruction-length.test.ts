/**
 * t-286：**280 那道闸此前要撞上才知道，而量错它的办法有三种，今晚三种都出现过。**
 *
 * · `bash` 的 `${#M}` 在 `LANG`／`LC_ALL` 为空时数**字节**，中文一字三字节：同一条 qa 得 354、服务端算 180。
 * · 这道闸数的是 **UTF-16 单元**（`.length`），而 `label`／`shows` 数的是**码点**（`[...s].length`）——纯 BMP
 *   两者相同，遇代理对（emoji）分叉。
 * · `verifyflow.ts:85` 拼自动卡时按**码点**算剩余位置，却要过这道按 UTF-16 量的闸（同族第三处，本件只报告不改）。
 *
 * 所以这份用例钉的不是「预检算得对」，是**预检与闸叫同一个函数**：`instructionBodyLength` 一处定义，
 * `rules.ts` 与命令行各引一次。下面每个样本都同时问两边，并且把「若照另外两把尺量会得几」一起摆出来——
 * **一个只断言相等的用例，在两边同时错的时候也是绿的。**
 */
import { describe, it, expect } from "vitest";
import { validate } from "../src/rules.js";
import { reduce } from "../src/reduce.js";
import { INSTRUCTION_MAX_CHARS, instructionBodyLength, instructionOverBy, tooLongLine } from "../src/events.js";

const S = reduce({ events: [], cursors: [], deliveries: [] });
const send = (body: string) => validate(S, { kind: "instruction", actor: "dev", to: "pm", body, ack_by: new Date(Date.now() + 60_000).toISOString() } as never, "human");
/** 服务端拒绝话里报的那个数，从原话里抠出来——**不是重算一遍**，那样就等于自己跟自己对。 */
function refusedCount(body: string): number {
  try { send(body); return -1; }
  catch (e) { return Number(/body is (\d+) chars/.exec((e as Error).message)?.[1] ?? NaN); }
}
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const points = (s: string) => [...s].length;
/** 造一条**恰好 n 个码点**的串。t-287 之后按码点造，`slice` 那种按 UTF-16 切的写法会把代理对劈成半个。 */
const rep = (unit: string, n: number) => [...unit.repeat(Math.ceil(n / [...unit].length))].slice(0, n).join("");

const SAMPLES = [
  { name: "纯 ASCII", body: rep("a", 300) },
  { name: "纯中文", body: rep("中", 300) },
  { name: "中英混合", body: rep("中a文b", 300) },
  { name: "含 emoji（代理对）", body: rep("好👍", 300) },   // 300 码点 = 400 UTF-16 单元
  { name: "边界 281（超一个）", body: rep("a", INSTRUCTION_MAX_CHARS + 1) },
];

describe("t-286 判据 2 · 预检与闸量同一个量", () => {
  it("五个样本，预检的数与服务端拒绝话里的数逐字相同", () => {
    for (const s of SAMPLES) {
      expect(refusedCount(s.body), `${s.name}：闸报的数`).toBe(instructionBodyLength(s.body));
      expect(instructionOverBy(s.body), `${s.name}：超了几个`).toBe(instructionBodyLength(s.body) - INSTRUCTION_MAX_CHARS);
      expect(tooLongLine(s.body), `${s.name}：那句话里印的也是这个数`).toContain(`${instructionBodyLength(s.body)} 字`);
    }
  });

  it("边界 280 正好不超：闸不拒，预检也不出声", () => {
    const ok = rep("a", INSTRUCTION_MAX_CHARS);
    expect(() => send(ok), "280 是「最多」，不是「少于」").not.toThrow();
    expect(instructionOverBy(ok)).toBe(0);
    const over = rep("a", INSTRUCTION_MAX_CHARS + 1);
    expect(refusedCount(over)).toBe(INSTRUCTION_MAX_CHARS + 1);
    expect(instructionOverBy(over)).toBe(1);
  });

  it("**不是字节**：同一条中文，字节数是它的三倍——qa 那 354 对 180 就是这么来的", () => {
    const zh = rep("中", 300);
    expect(bytes(zh)).toBe(900);
    expect(instructionBodyLength(zh), "闸量的是 UTF-16 单元，不是字节").toBe(300);
    expect(instructionBodyLength(zh)).not.toBe(bytes(zh));
  });

  /**
   * t-287：**这一格就是边界动的那一格，改前红改后绿。**
   *
   * `"a"×279 + "👍"` 码点 280、UTF-16 单元 281。t-286 那版（`.length`）**拒它**并报 281；收成码点之后
   * **它过**。这条断言的是闸的判决（`validate` 抛不抛），不是某个函数的返回值——函数层与真路是两格（t-285）。
   */
  it("**边界动了：280 码点、281 单元的那一条，从被拒变成通过**", () => {
    const justOver = "a".repeat(INSTRUCTION_MAX_CHARS - 1) + "👍";
    expect(points(justOver), "码点 280").toBe(INSTRUCTION_MAX_CHARS);
    expect(justOver.length, "UTF-16 单元 281").toBe(INSTRUCTION_MAX_CHARS + 1);
    expect(() => send(justOver), "收成码点之后它过得去").not.toThrow();
    expect(instructionOverBy(justOver), "预检也说没超").toBe(0);
    // 再往前一个码点就该拒，而且报的是码点数——**边界仍在，只是换了把尺**
    const oneMore = "a".repeat(INSTRUCTION_MAX_CHARS) + "👍";
    expect(points(oneMore)).toBe(INSTRUCTION_MAX_CHARS + 1);
    expect(refusedCount(oneMore)).toBe(INSTRUCTION_MAX_CHARS + 1);
    expect(instructionBodyLength("a👍b"), "只有代理对那一族变了：4 → 3").toBe(3);
  });

  it("**判决变化的输入恰好是且仅是含代理对的那些**：纯 BMP 一条也不受影响", () => {
    for (const unit of ["a", "中", "。", "Ω"]) {
      const at = rep(unit, INSTRUCTION_MAX_CHARS);
      const over = rep(unit, INSTRUCTION_MAX_CHARS + 1);
      expect(points(at), `${unit}：纯 BMP 两把尺逐字相同`).toBe(at.length);
      expect(() => send(at), `${unit}：280 照旧过`).not.toThrow();
      expect(refusedCount(over), `${unit}：281 照旧拒，报的数也没变`).toBe(INSTRUCTION_MAX_CHARS + 1);
    }
  });
});
