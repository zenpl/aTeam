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
const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

const SAMPLES = [
  { name: "纯 ASCII", body: rep("a", 300) },
  { name: "纯中文", body: rep("中", 300) },
  { name: "中英混合", body: rep("中a文b", 300) },
  { name: "含 emoji（代理对）", body: rep("好👍", 300) },
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

  it("**emoji 上两把尺分叉，而这里照抄服务端此刻用的那把**：一个 emoji 算 2，不算 1", () => {
    const e = rep("好👍", 300);
    expect(points(e), "码点那把尺会少数").toBeLessThan(instructionBodyLength(e));
    expect(instructionBodyLength(e), "闸报的就是这个").toBe(refusedCount(e));
    expect(instructionBodyLength("a👍b")).toBe(4);
    expect(points("a👍b")).toBe(3);
    // 判据 2 那句「不许按更合理选」：如果预检改用码点，下面这条就会红——**它正是会被放过去的那一格**。
    const justOver = "a".repeat(INSTRUCTION_MAX_CHARS - 1) + "👍";   // 码点 280、UTF-16 281
    expect(points(justOver)).toBe(INSTRUCTION_MAX_CHARS);
    expect(instructionBodyLength(justOver)).toBe(INSTRUCTION_MAX_CHARS + 1);
    expect(refusedCount(justOver), "服务端拒它；按码点量的预检会说「没超」").toBe(INSTRUCTION_MAX_CHARS + 1);
  });
});
