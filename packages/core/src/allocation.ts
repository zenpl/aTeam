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
/**
 * t-123 (pd, criterion 1): a second instruction from the same person to the same person is not, by itself, a mistake.
 * The first version counted every one of them as "自己更正" and reported a number nobody could act on — the same
 * measurement covered "我上一条写错了" and "生产刚换了 sha，重发一次". Those are opposite facts: one is a quality
 * problem, the other is the world moving. So they are counted apart, and only the first is reported as a quality
 * metric. A follow-up that says neither is left uncounted rather than guessed at: an unclassified follow-up inflating
 * a quality number is exactly how the first version became untrustworthy.
 */
export type FollowUp = "更正" | "更新" | "说不好";
/**
 * Saying, in so many words, that one's own earlier message was wrong. Two forms and no more: leading with 更正 (which
 * is how this team writes one — 「更正：验 7125bde 而不是 b27980d」, 「更正我 23:15 那条」), or owning the mistake in
 * the first person. Merely *containing* one of those words is not enough and was tried: 「自我更正率」, 「t-064 撤回」
 * and 「我那五条作废」 all matched a looser pattern, and none of them is somebody correcting their own instruction.
 */
const CORRECTION_RE = /^\s*(?:再)?(?:更正|纠正|改正)|我(?:说|写|搞|弄|打|记|数|看)错|我看漏|我(?:口|笔)误|是我错|我那(?:句|条)错|我错了/;
/** Saying that something outside moved, which is why there is a second one. */
const CHANGE_RE = /情况变|已经变|刚变|现在(?:是|已)|已经是|已上线|刚上线|上线了|生产已|换成|改成了|更新为|新的 sha|已合|已推|刚推|刚合|之后又|不再/;

/** Which of the two a follow-up is. `undo` is an untell of the earlier one: taking something back says it plainly. */
export function classifyFollowUp(later: string, undo = false): FollowUp {
  if (undo || CORRECTION_RE.test(later)) return "更正";
  if (CHANGE_RE.test(later)) return "更新";
  return "说不好";
}

/**
 * t-123 (pd 01:56, criterion 2): one line per pattern per period, the worst one. Four lines at once is four lines
 * nobody reads. `severity` is how far past its own threshold a finding is — dimensionless, so findings measured in
 * percentages, minutes and counts can still be compared to each other.
 */
interface Candidate { text: string; severity: number }
const worst = (cs: Candidate[]): Candidate | null => cs.length ? cs.reduce((a, b) => (b.severity > a.severity ? b : a)) : null;

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
    // t-123 判据 2: one line, the worst — here, the responsibility the most roles hold at once
    const pick = ids.filter((id) => roles.filter((r) => packing[r].includes(id)).length >= 2 && !roles.some((r) => bounds.get(`${r}:${id}`)))
      .map((id) => ({ id, holders: roles.filter((r) => packing[r].includes(id)) }))
      .reduce((a, b) => (b.holders.length > a.holders.length ? b : a));
    out.push({ pattern: "重叠", evidence: [`${pick.id} 由 ${pick.holders.join("、")} 同时持有，没有分界${overlaps.length > 1 ? `（另有 ${overlaps.length - 1} 项同样如此）` : ""}`],
      hint: `${pick.id} 由 ${pick.holders.join(" 和 ")} 同时持有，没有分界。建议：一个持有，另一个只提 concern。` });
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
    // t-123 判据 2: one line, the worst — here, the role holding the most alongside its R6
    out.push({ pattern: "打破独立审核", evidence: [`${broken[0]}${broken.length > 1 ? `（另有 ${broken.length - 1} 个角色同样如此）` : ""}`],
      hint: `${r} 同时持有 ${with_[0]} 与 R6。它${with_[0] === "R3" ? "定标准" : "做"}的东西只能由 owner 验；建议把 ${with_[0]} 交给 owner 或再起一个角色。` });
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
  const ineff: Candidate[] = [];
  const resolutions = [...s.seams.values()].map((x) => x.resolution).filter((r): r is NonNullable<typeof r> => !!r && inWindow(r.at));
  if (resolutions.length >= 5) {
    const by = tally(resolutions.map((r) => r.by));
    const [who, n] = by[0];
    const share = n / resolutions.length;
    if (share >= 0.8) ineff.push({ text: `接缝 ${pct(n, resolutions.length)} 由 ${who} 手工解决（${n}/${resolutions.length}）`, severity: share / 0.8 });
  }
  const p90s = roles.map((r) => {
    const delays = instructions.filter((st) => st.instruction.to === r && st.acked_at).map((st) => Date.parse(st.acked_at!) - Date.parse(st.instruction.at)).sort((a, b) => a - b);
    return { role: r, n: delays.length, p90: delays.length ? delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.9))] : null };
  });
  const slow = p90s.filter((x) => x.n >= 3 && x.p90 !== null);
  if (slow.length >= 2) {
    const slowest = [...slow].sort((a, b) => b.p90! - a.p90!)[0];
    const others = slow.filter((x) => x !== slowest).map((x) => x.p90!).sort((a, b) => a - b);
    const med = others[Math.floor(others.length / 2)];
    if (slowest.p90! > 15 * 60_000 && slowest.p90! >= 3 * Math.max(med, 60_000))
      ineff.push({ text: `${slowest.role} 的 ack 延迟 p90 ${mins(slowest.p90!)} 分钟，其他角色中位数 ${mins(med)} 分钟`, severity: slowest.p90! / (15 * 60_000) });
  }
  const waiting = [...s.tasks.values()].filter((t) => t.status === "done");
  if (waiting.length >= 5) ineff.push({ text: `等验队列 ${waiting.length} 件（${waiting.map((t) => t.id).join("、")}）`, severity: waiting.length / 5 });
  const badIneff = worst(ineff);
  if (badIneff) out.push({ pattern: "低效", evidence: [badIneff.text], hint: `${badIneff.text}。建议：把靠人手工做的改成规则或服务；等验的先验。` });

  // ---- 无效上下文移交
  const handoff: Candidate[] = [];
  const grams: GramCache = new Map();   // t-131: one call's worth of bigram sets, shared by both loops below
  const list = instructions.map((st) => st.instruction).sort((a, b) => a.at.localeCompare(b.at));
  const forwards: [Instruction, Instruction][] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (Date.parse(b.at) - Date.parse(a.at) > TEN_MIN) break;
    if (a.actor !== b.actor && similarAtLeast(a.body, b.body, 0.6, grams)) forwards.push([a, b]);
  }
  if (forwards.length) {
    const by = tally(forwards.map(([, b]) => b.actor));
    handoff.push({ text: `${by[0][0]} 十分钟内转发了 ${by[0][1]} 条别人的话（正文相似度 ≥ 0.6）`, severity: by[0][1] });
  }
  const hops = saidHops(s, human).filter((h) => h.hops > 2);
  if (hops.length) handoff.push({ text: `${hops.length} 句「说一句」到任务超过两跳（${hops.map((h) => `${h.task}: ${h.hops} 跳`).join("、")}）`, severity: Math.max(...hops.map((h) => h.hops)) / 2 });
  const badHandoff = worst(handoff);
  if (badHandoff) out.push({ pattern: "无效上下文移交", evidence: [badHandoff.text], hint: `${badHandoff.text}。建议：human 的话直接进日志（说一句），中间角色只加判据。` });

  // ---- 重叠 (runtime): two decision notes on one task within ten minutes, neither superseding the other
  const decisions = s.notes.filter((n) => n.decision && n.task && inWindow(n.at));
  const dup: Candidate[] = [];
  for (let i = 0; i < decisions.length; i++) for (let j = i + 1; j < decisions.length; j++) {
    const a = decisions[i], b = decisions[j];
    if (a.task !== b.task || Math.abs(Date.parse(a.at) - Date.parse(b.at)) > TEN_MIN) continue;
    if (a.supersedes === b.id || b.supersedes === a.id) continue;
    dup.push({ text: `${a.task} 十分钟内有两条互不取代的决策（${a.actor} ${a.id.slice(-6)} 与 ${b.actor} ${b.id.slice(-6)}）`, severity: 2 });
  }
  const near: Candidate[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (Date.parse(b.at) - Date.parse(a.at) > FIVE_MIN) break;
    if (a.to === b.to && a.actor !== b.actor && similarAtLeast(a.body, b.body, 0.6, grams))
      near.push({ text: `${a.to} 五分钟内收到 ${a.actor} 与 ${b.actor} 内容相近的两条指令`, severity: 1 });
  }
  const badOverlap = worst([...dup, ...near]);   // a decision collision outranks two similar instructions
  if (badOverlap) out.push({ pattern: "重叠", evidence: [badOverlap.text], hint: `${badOverlap.text}。建议：一个持有，另一个只提 concern；改决定用 --supersedes。` });

  // ---- 负载陷阱 (runtime)
  const load: Candidate[] = [];
  const sent = list.filter((i) => i.to !== human);
  if (sent.length >= 10) {
    const by = tally(sent.map((i) => i.to));
    const [who, n] = by[0];
    const share = n / sent.length;
    if (share > 0.5) load.push({ text: `${who} 收到 ${pct(n, sent.length)} 的指令（${n}/${sent.length}）`, severity: share / 0.5 });
  }
  for (const [who, c] of selfCorrections(s, list)) {
    if (c.sent < 10) continue;
    const rate = c.更正 / c.sent;
    const aside = c.更新 || c.说不好 ? `；另有 ${c.更新} 条是情况变了才重发的、${c.说不好} 条说不好，都不计入` : "";
    if (rate >= 0.15) load.push({ text: `${who} ${pct(c.更正, c.sent)} 的指令是自己写错后更正的（${c.更正}/${c.sent}）${aside}`, severity: rate / 0.15 });
  }
  const badLoad = worst(load);
  if (badLoad) out.push({ pattern: "负载陷阱", evidence: [badLoad.text], hint: `${badLoad.text}。建议：把它持有的、能改成规则或服务的职责先拿走。` });

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

function bigrams(x: string): Set<string> {
  const cs = [...x.replace(/\s+/g, "")];
  const g = new Set<string>();
  for (let i = 0; i + 1 < cs.length; i++) g.add(cs[i] + cs[i + 1]);
  return g;
}

/**
 * t-131: the two loops below compare every instruction with the others inside a time window, so one body is cut into
 * bigrams once per pairing it takes part in — with a busy hour and long messages that dominated the whole board.
 * The cache lives for one `allocation()` call: reuse is within a call, and nothing outgrows the request.
 */
export type GramCache = Map<string, Set<string>>;
const gramsOf = (cache: GramCache | undefined, x: string): Set<string> => {
  if (!cache) return bigrams(x);
  let g = cache.get(x);
  if (!g) cache.set(x, (g = bigrams(x)));
  return g;
};

/**
 * Jaccard cannot reach `min` when one set is smaller than `min` times the other: their intersection is at most the
 * smaller set. So the sizes alone rule most pairs out, exactly — never a pair that would have passed.
 */
const cannotReach = (a: number, b: number, min: number) => Math.min(a, b) < min * Math.max(a, b);

/**
 * t-123: per author, how their own follow-ups break down. A follow-up is a second instruction *about the same thing*
 * to the same person soon after — same actor, same recipient, within ten minutes, and either saying much the same
 * thing again or naming the first outright. Two instructions to one person about two different things are two
 * instructions, which is what the first version could not tell apart, and why its number read four times too high.
 *
 * Only 更正 is a quality metric. 更新 (the world moved) is counted and shown beside it so the two are never added up
 * again, and 说不好 is counted and reported as neither: a follow-up nobody can classify is not evidence of anything.
 */
export function selfCorrections(s: State, list: Instruction[]): Map<string, { sent: number; 更正: number; 更新: number; 说不好: number }> {
  const undone = new Set<string>();     // taking an instruction back says plainly that it should not have been sent
  for (const st of s.instructions.values()) if (st.withdrawn) undone.add(st.instruction.id);
  const out = new Map<string, { sent: number; 更正: number; 更新: number; 说不好: number }>();
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const c = out.get(a.actor) ?? { sent: 0, 更正: 0, 更新: 0, 说不好: 0 };
    c.sent++;
    // The link is same author, same recipient, soon after; what kind of follow-up it is comes from what it says.
    // Pairing on similar wording was tried and failed on the real log: a correction rarely repeats what it corrects
    // (「更正我 23:15 那条：冻的是 sha，不是分支」), and the median similarity of these pairs is 0.06.
    const follow = list.slice(i + 1).find((b) => b.actor === a.actor && b.to === a.to && Date.parse(b.at) - Date.parse(a.at) <= TEN_MIN);
    if (follow || undone.has(a.id)) c[classifyFollowUp(follow?.body ?? "", undone.has(a.id))]++;
    out.set(a.actor, c);
  }
  return out;
}

/** Character-bigram Jaccard similarity: 1 for equal texts, 0 for nothing in common. */
export function similarity(a: string, b: string, cache?: GramCache): number {
  const A = gramsOf(cache, a), B = gramsOf(cache, b);
  if (!A.size && !B.size) return 1;
  let both = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const g of small) if (large.has(g)) both++;
  return both / (A.size + B.size - both);
}

/**
 * similarity(a, b) >= min, answered without computing the ratio wherever that is already settled: first by the set
 * sizes, then by giving up as soon as even matching every remaining gram could not reach `min`. Both are exact —
 * they only rule out pairs the full computation would have rejected too.
 */
export function similarAtLeast(a: string, b: string, min: number, cache?: GramCache): boolean {
  const A = gramsOf(cache, a), B = gramsOf(cache, b);
  if (!A.size && !B.size) return 1 >= min;
  if (cannotReach(A.size, B.size, min)) return false;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  const union = A.size + B.size;
  let both = 0, left = small.size;
  for (const g of small) {
    if (large.has(g)) both++;
    left--;
    // the best this pair can still reach, if every gram left over matched
    if ((both + left) / (union - both - left) < min) return false;
  }
  return both / (union - both) >= min;
}

function tally(xs: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;
const mins = (ms: number) => Math.round(ms / 60_000);
void PM_ACTOR;
