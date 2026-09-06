/**
 * t-061 · 分配预警 (responsibilities.md, 分配预警): five patterns of a bad split of responsibilities, computed by the
 * service from the declaration and the log. Soft: nothing here rejects an event. One entry per pattern per period,
 * each with its numbers, so the warnings never become noise (T10).
 */
import { PM_ACTOR, type Instruction } from "./events.js";
import { type State } from "./reduce.js";
import { projectRoles, roleResponsibilities, responsibilityBoundaries } from "./board.js";

export type AllocationPattern = "重叠" | "低效" | "无效上下文移交" | "打破独立审核" | "负载陷阱";
export const ALLOCATION_PATTERNS: AllocationPattern[] = ["重叠", "低效", "无效上下文移交", "打破独立审核", "负载陷阱"];
export interface AllocationWarning {
  pattern: AllocationPattern;
  /** What was seen, with the numbers, in the order found. */
  evidence: string[];
  /** The one sentence pd wrote for this pattern, filled in. */
  hint: string;
}
/** Reading key (surface project) the service writes the warnings to. */
export const ALLOCATION_KEY = "allocation";
/** The runtime metrics look back this far. */
export const ALLOCATION_WINDOW_MS = 4 * 3600_000;
/** The fact is rewritten at most this often when its patterns did not change. */
export const ALLOCATION_PERIOD_MS = 2 * 3600_000;
const TEN_MIN = 10 * 60_000;
const FIVE_MIN = 5 * 60_000;

/** Static checks, on the project's own declaration only: the default packing overlaps by design (dev/frontend on R5). */
export function staticAllocation(s: State): AllocationWarning[] {
  const packing = roleResponsibilities(s);
  if (!declaredPacking(s)) return [];
  const bounds = responsibilityBoundaries(s);
  const out: AllocationWarning[] = [];
  const roles = Object.keys(packing);
  // 重叠: one responsibility in two role sets, no boundary said on either side
  const overlaps: string[] = [];
  const ids = [...new Set(roles.flatMap((r) => packing[r]))];
  for (const id of ids) {
    const holders = roles.filter((r) => packing[r].includes(id));
    if (holders.length < 2 || holders.some((r) => bounds.get(`${r}:${id}`))) continue;
    overlaps.push(`${id} 由 ${holders.join("、")} 同时持有，没有分界`);
  }
  if (overlaps.length) {
    const first = ids.find((id) => roles.filter((r) => packing[r].includes(id)).length >= 2 && !roles.some((r) => bounds.get(`${r}:${id}`)))!;
    const holders = roles.filter((r) => packing[r].includes(first));
    out.push({ pattern: "重叠", evidence: overlaps, hint: `${first} 由 ${holders.join(" 和 ")} 同时持有，没有分界。建议：一个持有，另一个只提 concern。` });
  }
  // 打破独立审核: R3+R6 or R5+R6 in one role, and no owner degradation said on its R6
  const broken: string[] = [];
  for (const r of roles) {
    const has = (id: string) => packing[r].includes(id);
    if (!has("R6")) continue;
    const with_ = ["R3", "R5"].filter(has);
    if (!with_.length) continue;
    if (/owner|human/i.test(bounds.get(`${r}:R6`) ?? "")) continue;
    broken.push(`${r} 同时持有 ${with_.join("、")} 与 R6，没有 owner 退化声明`);
  }
  if (broken.length) {
    const r = roles.find((x) => packing[x].includes("R6") && ["R3", "R5"].some((id) => packing[x].includes(id)) && !/owner|human/i.test(bounds.get(`${x}:R6`) ?? ""))!;
    const with_ = ["R3", "R5"].filter((id) => packing[r].includes(id));
    out.push({ pattern: "打破独立审核", evidence: broken, hint: `${r} 同时持有 ${with_[0]} 与 R6。它${with_[0] === "R3" ? "定标准" : "做"}的东西只能由 owner 验；建议把 ${with_[0]} 交给 owner 或再起一个角色。` });
  }
  // 负载陷阱: one role holds far more than the others (not a two-node team: that is one person many hats by design)
  if (roles.length > 2) {
    const counts = roles.map((r) => [r, packing[r].length] as const).sort((a, b) => b[1] - a[1]);
    const [top, n] = counts[0];
    const rest = counts.slice(1).map((x) => x[1]);
    const median = rest.sort((a, b) => a - b)[Math.floor(rest.length / 2)];
    if (n >= 4 && n >= 2 * Math.max(median, 1)) {
      out.push({ pattern: "负载陷阱", evidence: [`${top} 持有 ${n} 项职责，其他角色中位数 ${median} 项`], hint: `${top} 持有 ${n} 项职责（${packing[top].join(" ")}），其他角色中位数 ${median}。建议：把能改成规则或服务的职责先拿走。` });
    }
  }
  return out;
}

/** Runtime metrics over the last window of the log, per criterion 2 of t-061. */
export function runtimeAllocation(s: State, now: Date, human: string): AllocationWarning[] {
  const since = now.getTime() - ALLOCATION_WINDOW_MS;
  const inWindow = (iso: string) => Date.parse(iso) >= since;
  const out: AllocationWarning[] = [];
  const roles = projectRoles(s);
  const instructions = [...s.instructions.values()].filter((st) => inWindow(st.instruction.at));

  // ---- 低效
  const ineff: string[] = [];
  const resolutions = [...s.seams.values()].map((x) => x.resolution).filter((r): r is NonNullable<typeof r> => !!r && inWindow(r.at));
  if (resolutions.length >= 5) {
    const by = tally(resolutions.map((r) => r.by));
    const [who, n] = by[0];
    if (n / resolutions.length >= 0.8) ineff.push(`接缝 ${pct(n, resolutions.length)} 由 ${who} 手工解决（${n}/${resolutions.length}）`);
  }
  const p90s = roles.map((r) => {
    const delays = instructions.filter((st) => st.instruction.to === r && st.acked_at).map((st) => Date.parse(st.acked_at!) - Date.parse(st.instruction.at)).sort((a, b) => a - b);
    return { role: r, n: delays.length, p90: delays.length ? delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.9))] : null };
  });
  const slow = p90s.filter((x) => x.n >= 3 && x.p90 !== null);
  if (slow.length >= 2) {
    const worst = [...slow].sort((a, b) => b.p90! - a.p90!)[0];
    const others = slow.filter((x) => x !== worst).map((x) => x.p90!).sort((a, b) => a - b);
    const med = others[Math.floor(others.length / 2)];
    if (worst.p90! > 15 * 60_000 && worst.p90! >= 3 * Math.max(med, 60_000)) ineff.push(`${worst.role} 的 ack 延迟 p90 ${mins(worst.p90!)} 分钟，其他角色中位数 ${mins(med)} 分钟`);
  }
  const waiting = [...s.tasks.values()].filter((t) => t.status === "done");
  if (waiting.length >= 5) ineff.push(`等验队列 ${waiting.length} 件（${waiting.map((t) => t.id).join("、")}）`);
  if (ineff.length) out.push({ pattern: "低效", evidence: ineff, hint: `${ineff[0]}。建议：把靠人手工做的改成规则或服务；等验的先验。` });

  // ---- 无效上下文移交
  const handoff: string[] = [];
  const list = instructions.map((st) => st.instruction).sort((a, b) => a.at.localeCompare(b.at));
  const forwards: [Instruction, Instruction][] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (Date.parse(b.at) - Date.parse(a.at) > TEN_MIN) break;
    if (a.actor !== b.actor && similarity(a.body, b.body) >= 0.6) forwards.push([a, b]);
  }
  if (forwards.length) {
    const by = tally(forwards.map(([, b]) => b.actor));
    handoff.push(`${by[0][0]} 十分钟内转发了 ${by[0][1]} 条别人的话（正文相似度 ≥ 0.6）`);
  }
  const hops = saidHops(s, human).filter((h) => h.hops > 2);
  if (hops.length) handoff.push(`${hops.length} 句「说一句」到任务超过两跳（${hops.map((h) => `${h.task}: ${h.hops} 跳`).join("、")}）`);
  if (handoff.length) out.push({ pattern: "无效上下文移交", evidence: handoff, hint: `${handoff[0]}。建议：human 的话直接进日志（说一句），中间角色只加判据。` });

  // ---- 重叠 (runtime): two decision notes on one task within ten minutes, neither superseding the other
  const decisions = s.notes.filter((n) => n.decision && n.task && inWindow(n.at));
  const dup: string[] = [];
  for (let i = 0; i < decisions.length; i++) for (let j = i + 1; j < decisions.length; j++) {
    const a = decisions[i], b = decisions[j];
    if (a.task !== b.task || Math.abs(Date.parse(a.at) - Date.parse(b.at)) > TEN_MIN) continue;
    if (a.supersedes === b.id || b.supersedes === a.id) continue;
    dup.push(`${a.task} 十分钟内有两条互不取代的决策（${a.actor} ${a.id.slice(-6)} 与 ${b.actor} ${b.id.slice(-6)}）`);
  }
  const near: string[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (Date.parse(b.at) - Date.parse(a.at) > FIVE_MIN) break;
    if (a.to === b.to && a.actor !== b.actor && similarity(a.body, b.body) >= 0.6) near.push(`${a.to} 五分钟内收到 ${a.actor} 与 ${b.actor} 内容相近的两条指令`);
  }
  if (dup.length || near.length) out.push({ pattern: "重叠", evidence: [...dup, ...near], hint: `${(dup[0] ?? near[0])}。建议：一个持有，另一个只提 concern；改决定用 --supersedes。` });

  // ---- 负载陷阱 (runtime)
  const load: string[] = [];
  const sent = list.filter((i) => i.to !== human);
  if (sent.length >= 10) {
    const by = tally(sent.map((i) => i.to));
    const [who, n] = by[0];
    if (n / sent.length > 0.5) load.push(`${who} 收到 ${pct(n, sent.length)} 的指令（${n}/${sent.length}）`);
  }
  const corrections = new Map<string, { sent: number; corrected: number }>();
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const k = a.actor;
    const c = corrections.get(k) ?? { sent: 0, corrected: 0 };
    c.sent++;
    if (list.slice(i + 1).some((b) => b.actor === a.actor && b.to === a.to && Date.parse(b.at) - Date.parse(a.at) <= TEN_MIN)) c.corrected++;
    corrections.set(k, c);
  }
  for (const [who, c] of corrections) if (c.sent >= 10 && c.corrected / c.sent >= 0.15) load.push(`${who} ${pct(c.corrected, c.sent)} 的指令在十分钟内被自己更正（${c.corrected}/${c.sent}）`);
  if (load.length) out.push({ pattern: "负载陷阱", evidence: load, hint: `${load.join("，")}。建议：把它持有的、能改成规则或服务的职责先拿走。` });

  return out;
}

/** All five patterns, one entry each at most: static findings first, runtime evidence merged into the same entry. */
export function allocation(s: State, now: Date, human: string): AllocationWarning[] {
  const merged = new Map<AllocationPattern, AllocationWarning>();
  for (const w of [...staticAllocation(s), ...runtimeAllocation(s, now, human)]) {
    const had = merged.get(w.pattern);
    if (had) had.evidence.push(...w.evidence); else merged.set(w.pattern, { ...w, evidence: [...w.evidence] });
  }
  return ALLOCATION_PATTERNS.filter((p) => merged.has(p)).map((p) => merged.get(p)!);
}

/** One line for the dig layer: 分配：2 条预警 / 分配：没有预警. */
export function allocationSummary(ws: AllocationWarning[]): string {
  return ws.length ? `分配：${ws.length} 条预警（${ws.map((w) => w.pattern).join("、")}）` : "分配：没有预警";
}

/** The declared {role: [ids]} packing, or null when the project only listed role names (or nothing). */
export function declaredPacking(s: State): Record<string, unknown> | null {
  const id = s.latestReading.get(`project:roles`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length ? (v as Record<string, unknown>) : null;
}

/** How many hops from a sentence the human said to each task that came of it: said → note → … → task, counting edges. */
export function saidHops(s: State, human: string): { task: string; hops: number }[] {
  const saidIds = new Set(s.notes.filter((n) => n.actor === human && n.body.startsWith("human 说：")).map((n) => n.id));
  const refsOf = new Map<string, string[]>();
  for (const n of s.notes) refsOf.set(n.id, n.refs ?? []);
  const out: { task: string; hops: number }[] = [];
  for (const t of s.tasks.values()) {
    let best: number | null = null;
    const walk = (refs: string[], depth: number, seen: Set<string>) => {
      for (const r of refs) {
        if (seen.has(r)) continue;
        seen.add(r);
        if (saidIds.has(r)) { if (best === null || depth < best) best = depth; continue; }
        if (refsOf.has(r)) walk(refsOf.get(r)!, depth + 1, seen);
      }
    };
    walk(t.refs, 1, new Set());
    if (best !== null) out.push({ task: t.id, hops: best });
  }
  return out;
}

/** Character-bigram Jaccard similarity: 1 for equal texts, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const grams = (x: string) => { const cs = [...x.replace(/\s+/g, "")]; const g = new Set<string>(); for (let i = 0; i + 1 < cs.length; i++) g.add(cs[i] + cs[i + 1]); return g; };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return both / (A.size + B.size - both);
}

function tally(xs: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;
const mins = (ms: number) => Math.round(ms / 60_000);
void PM_ACTOR;
