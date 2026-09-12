import { BOTH_BODY_AND_FILE, TWICE_GIVEN, UNKNOWN_FLAG, FLAG_NEEDS_VALUE } from "@ateam/core";
export interface Args {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

// t-173: 每一个 main.ts 里用 bool() 读的开关都必须在这里。漏一个，那个开关就是死的——`--x` 报「needs a value」，
// `--x true` 存成字符串而 bool() 仍然返回 false，两种写法都设不上，而且**不报错**。今天漏了两个：
// --no-human-impact（t-151 那道闸唯一的出路，出路死了等于逼人说假话）与 --missed（t-149 的补记）。
// --clear-refused 是同一根因的另一种症状：它绕过解析器直接查 argv，于是先打一行「needs a value」再照常
// 工作——不致命，但那行错误信息今晚出现在每一次 sync --clear-refused 上。
// build.test.ts 里有一条闸守着这份名单与 main.ts 里的用法一致（bool() 与 argv.includes 两种读法都查），别手工对。
const BOOLEAN = new Set(["pass", "fail", "decision", "json", "help", "quiet", "no-seam-check", "no-touches", "touches-only", "once", "force", "full", "no-human-impact", "missed", "clear-refused"]);
// t-197：同一根因的第二份名单，而这一份**一直没有闸**（frontend 11:36 实测：九个里五个不在——refs、touches、
// writes、depends-on、enum）。漏一个的症状比 BOOLEAN 那次更安静：`--refs a --refs b` 不报错、不重复，**后一个
// 静默盖掉前一个**，命令照常成功。后果不是小事：
//   · touches 少一个 = 一次不会被发现的接缝；
//   · refs 少一个 = 一次「我动过」被算成没动——t-193 之后 refs 正是「办了」的唯一凭据。
// build.test.ts 里现在有一条与 t-173 同形的闸守着这份名单与 main.ts 里 list() 的用法一致，别手工对。
const REPEATABLE = new Set(["criteria", "assumes", "option", "internal-only", "refs", "touches", "writes", "depends-on", "enum", "no-seam-check-for"]);
/**
 * t-247：**带值的那几个开关。第三份名单，也是最后一份没有闸的。**
 *
 * 此前解析器**认得一切**：`--完全不存在的开关 值` 照收不误，命令读不到它、于是一个字都不说地退 0。
 * qa 22:38 那条两千多字的判决就是这么落库的——它跑的那支 CLI 不认得 `--evidence-file`（t-246 刚加的），
 * **事件照落，evidence 是空的**。而同一支 CLI 上，一个**已知**开关缺值会报「needs a value」：
 * **两条路不在同一处，于是「写错名字」比「少写个值」更安静。**
 *
 * 三份名单合起来就是「这支 CLI 认得的全部」；`--X-file`（t-246）算认得，只要 X 在里面。
 * build.test.ts 里有一条闸守着这一份与 main.ts 里 `str()` 的用法一致——别手工对。
 */
const VALUED = new Set(["ack-by", "after", "anyway", "body", "by", "default", "deploy", "evidence", "interval", "kind", "me", "measured-at", "method", "on", "push", "reason", "resolution", "rollback", "shape", "shows", "start", "step", "supersedes", "surface", "task", "to", "token", "url", "valid-for", "valid-until", "verdict", "wait"]);

/** 这支命令行认得的开关，含 t-246 那一族 `--X-file`。说不认得的时候，指名是哪一个。 */
export function known(name: string): boolean {
  const base = name.endsWith("-file") ? name.slice(0, -"-file".length) : name;
  return BOOLEAN.has(base) || REPEATABLE.has(base) || VALUED.has(base) || BOOLEAN.has(name) || REPEATABLE.has(name) || VALUED.has(name);
}

/**
 * t-246：**`--X-file <路径>` 从文件读 `--X` 的值。**
 *
 * 今天反引号咬了三个人至少五次，而全队的对策是「每个人记得先写文件、再 `"$(cat …)"`」——
 * pm 17:2x 把这条规矩广播给全队，**45 分钟后 qa 就在一条生产判决的证据里踩了同一个坑**；
 * dev 09-07 也立过同一条，只对长 note 执行、短 tell 从没执行。**一条要五个人各自记住的规矩，
 * 今天量到的失效间隔是 45 分钟。** 所以出路不是再广播一次，是让工具自己收得下这段字。
 *
 * 两条都给了就报用法错，不猜哪个算数：**两份正文里挑一份，挑错了是一句没人会核的假话。**
 */
export function fromFiles(out: Args, read: (p: string) => string): void {
  for (const key of Object.keys(out.flags)) {
    if (!key.endsWith("-file")) continue;
    const base = key.slice(0, -"-file".length);
    if (!base) continue;
    if (out.flags[base] !== undefined) throw new UsageError(BOTH_BODY_AND_FILE(base));
    const path = String(out.flags[key]);
    // 文件总是以换行结尾，而那个换行不是正文的一部分——不修掉它，每一条走这条路的正文都会多一个空行。
    // 只修尾部：正文里的换行是作者写的，一个都不许动。
    out.flags[base] = read(path).replace(/\s+$/, "");
    delete out.flags[key];
  }
}

export function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    // t-247：**不认得就出声，并指名是哪一个。** 此前它照收不误、命令读不到、一个字不说地退 0——
    // 而一个拼错的开关与一个不存在的开关长得一样，两者的后果都是「事件落了，那个字段是空的」。
    if (!known(name)) throw new UsageError(UNKNOWN_FLAG(name));
    let value: string | boolean;
    if (eq > 0) value = a.slice(eq + 1);
    else if (BOOLEAN.has(name)) value = true;
    else { value = argv[++i]; if (value === undefined) throw new UsageError(FLAG_NEEDS_VALUE(name)); }
    if (REPEATABLE.has(name)) {
      const arr = (out.flags[name] as string[] | undefined) ?? [];
      arr.push(String(value));
      out.flags[name] = arr;
    } else {
      // t-246 ②（qa 22:42）：**同一个 --X 给两次，后一个静默胜出。** 它咬的第一件事就是 `--body-file`：
      // 两份正文里工具替你挑了一份，而挑错了是一句没人会核的假话。t-197 那条注释早就写过这个形状
      // （`--refs a --refs b` 后一个静默盖掉前一个），当时的出路是把该重复的加进 REPEATABLE；
      // **不该重复的那些，此刻一律改成当场报用法错**——两份值里挑一份，工具不替你挑。
      if (out.flags[name] !== undefined) throw new UsageError(TWICE_GIVEN(name));
      out.flags[name] = value;
    }
  }
  return out;
}

export function str(a: Args, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === "string" ? v : undefined;
}
const commas = (xs: string[]) => xs.flatMap((x) => x.split(",")).map((s) => s.trim()).filter(Boolean);
/**
 * t-197 之后的一个回归，我自己刚踩到：把 `touches` 加进 REPEATABLE 之后，`--touches "a,b,c"` 走的是数组那一支，
 * **逗号不再拆**——于是那一整串被当成一个触点存进日志（我 12:15 那次 claim 就是这么记下的），而说明书与 --help
 * 教的正是 `--touches a,b`。两种写法都要成立：给几次就是几段，每段里的逗号照拆。
 */
export function list(a: Args, name: string): string[] | undefined {
  const v = a.flags[name];
  if (Array.isArray(v)) return commas(v);
  if (typeof v === "string") return commas([v]);
  return undefined;
}
export function bool(a: Args, name: string): boolean {
  return a.flags[name] === true;
}

/** "15m" | "2h" | "30s" | "1d" -> ms */
export function duration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}" (use 30s, 15m, 2h, 1d)`);
  const n = Number(m[1]);
  return n * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s" | "m" | "h" | "d"];
}

/** A command line that cannot mean what was typed. Exit 2, like a rejection: the system said no before anything happened. */
export class UsageError extends Error {}

/**
 * Exactly these positionals, in order. Anything beyond them is refused and echoed back, so a stray word never
 * lands silently in a title or a body; a multi-word value has to be quoted.
 */
export function exact(rest: string[], ...names: string[]): string[] {
  if (rest.length > names.length) {
    const got = rest.map((r, i) => `  ${i + 1}. ${JSON.stringify(r)}`).join("\n");
    const want = names.length ? names.map((n) => `<${n}>`).join(" ") : "no positional arguments";
    throw new UsageError(`expected ${want}, got ${rest.length}:\n${got}\nQuote a value that has spaces: "...". Nothing was sent.`);
  }
  return names.map((n, i) => {
    const v = rest[i];
    if (v === undefined || !v.trim()) throw new UsageError(`missing <${n}>`);
    return v;
  });
}

/** `--measured-at`: an ISO time, or how long ago as a duration ("10m" = ten minutes before now). */
export function measuredAtOf(s: string, now: Date): string {
  const v = s.trim();
  if (/^\d+(?:\.\d+)?\s*(s|m|h|d)$/.test(v)) return new Date(now.getTime() - duration(v)).toISOString();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new UsageError(`--measured-at ${JSON.stringify(s)}: give an ISO time or how long ago (10m, 2h)`);
  return new Date(t).toISOString();
}
