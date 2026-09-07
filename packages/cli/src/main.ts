import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { WATCH_INTERVAL, roleNamer, boardTask, Rejected, type ClientEvent, SAID_PREFIX, SAID_MAX_CHARS, PUSH_LEVELS, NODE_SURFACE, capabilityKey } from "@ateam/core";
import { parse, str, list, bool, duration, exact, measuredAtOf, UsageError, type Args } from "./args.js";
import { Client, ClientError, ShapeError, seen } from "./client.js";
import { resolveConfig, initFields, joinOutput, type Config } from "./config.js";
import * as fmt from "./format.js";
import { trace, isSha } from "./trace.js";
import { seamWarnings, seamCheck, gitIsAncestor } from "./seamcheck.js";
import { blockingLock, writeLock, removeLock } from "./lock.js";
import { watchState, listeningNotices, pullIdle } from "./deaf.js";
import { revise, baseAt, changedFiles, type Diff } from "./touches.js";
import { readRefusal, refusalNotice, actionOf, type Refusal } from "./rejected.js";
import { deploy, realGit, containment, containmentFact } from "./release.js";
import { fixtureText } from "./fixture.js";
import { splitTitle, TITLE_MAX_CHARS, type InstructionIntent } from "@ateam/core";
import { sync, watch, type CursorStore } from "./loop.js";
import { decide } from "./decide.js";

const HELP = `ateam — the shared log for a team of sessions

setup
  ateam join --me <role> [--url <server>] [--token <t>] [--push none|own-branch|integration|production]   become a node: writes .ateam/config.json, syncs once, prints the role's manual (init is an alias); --push records what you may push as the fact node:<role>:能力
  ateam init --me <role> [--url <server>] [--token <t>]   writes the given fields to .ateam/config.json
                                                          precedence per field: env ATEAM_ME / ATEAM_URL / ATEAM_TOKEN beats the file; the file fills what the env leaves unset

every turn
  ateam sync [--wait 25s]        pull new events since your cursor; instructions for you are marked. --wait long-polls.
  ateam ack <id>                 acknowledge an instruction addressed to you
  ateam untell <id> --reason "..."   take back an instruction you sent, before it is acked or decided; the recipient sees 已撤回
  ateam board [--json] [--full]           what is true, what is open, who is here
  ateam fixture [--start <iso>] [--step 1m]   a sample log (events, cursors, deliveries) built with the server's own code, to stdout; no server needed
  ateam release [--json] [--deploy <sha>] [--anyway "<理由>"]   --deploy 推的是一个 sha，不是分支名（分支头随时会前进到还没验收的提交）；含未验收任务时拒绝，--anyway 带理由可越过并留痕
      what passed on repo and not yet on production; --deploy pushes that sha to the production branch (fact project:deploy.enabled, credential ATEAM_DEPLOY_TOKEN)

say things
  ateam tell <to> <body> [--ack-by 15m] [--kind ask|do|info]         instruction: one recipient, ≤280 chars, must be acked; --kind only for human
  ateam tell human <body> --option A --option B [--default B]        a decision for the human; the board shows one button per option
  ateam decide <id> <option>                                         choose for an instruction with options: acks it and records the decision
  ateam reading <key> <value> --surface <s> [--depends-on a,b] [--assumes "..."]... [--valid-for 6h] [--method m]
                                    [--shape <regex>] [--enum a,b,c]   declare once what values <key> may take; later mismatches are rejected
                                    [--measured-at <ISO | 10m>]        when the world was measured (10m = ten minutes ago); validity counts from it
  ateam say <正文>                                                   human only: one sentence to the team; the board shows where it went
  ateam focus <body>                                                 the one thing that matters most right now
  ateam note <body> [--decision] [--supersedes <id>] [--task <id>]    --task attaches it to a task (task show, board, GET /); "evidence: ..." updates the evidence

tasks
  ateam task show <id>                       title, status, owner, criteria, touches, evidence, verifications, seams
  ateam task create <id> <title> --criteria "..." [--criteria "..."]
  ateam task claim <id> --touches a,b        declare the paths/symbols/fields you will change
  ateam task done <id> [--evidence "..."] [--shows "一句话：人能看到什么"] [--touches 符号,字段] [--no-touches] [--no-seam-check]
                                             claim 的 touches 是声明，done 的是事实：默认从本分支相对 claim 起点的 diff 量出实际改动的文件，
                                             --touches 补 diff 量不到的（符号、字段、接口名）；量不出来时（没有 git、没起点）--touches 就是最终值，覆盖声明那份；
                                             --touches-only 表示「我写的这几条就是全部」——一条分支上连做几件时 diff 分不出是哪一件的，
                                             
                                             --no-touches 原样沿用声明。重算后冒出新接缝会挡住 done。另外，若已定接缝的另一侧没并进你的证据 sha，会告警
  ateam task verify <id> --surface <s> (--pass|--fail) [--evidence "..."] [--shows "..."]
  ateam task block <id> --on "..." | ateam task unblock <id>
  ateam task withdraw <id> --reason "..."   terminal; only open/blocked tasks, by the criteria author, pm or human
  ateam task obsolete <id> --by <decision note id> [--reason "..."]   terminal; a done/failed task a decision made moot, by the criteria author, pm, pd or human
  ateam task reopen <id> --reason "..."     done/failed -> working again, same owner and touches; by the owner, pm or human
  ateam task criteria add <id> "..."         one more criterion, numbered after the rest; by a criteria author, pm, pd or human; not once verified
  ateam task seam <a> <b> --resolution "..."

any emit accepts --refs <ids> (what you build on; stale readings are rejected) and --writes <surface:key,...> (what you changed).

  ateam trace <task-id | sha>    the story of a change: what asked for it, who decided, who judged it where
  ateam log [--after <id>]       raw events
  ateam watch [--interval ${WATCH_INTERVAL}] [--once] [--force]   keep listening: prints what arrives and "instruction received" each time; --once exits on the first instruction; one watch per identity per checkout (--force overrides the lock)
`;

const configFile = () => join(process.cwd(), ".ateam", "config.json");

function loadConfig(): Config {
  const file = configFile();
  const f = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
  return resolveConfig(f, process.env);
}

function cursorFile(me: string) { return join(process.cwd(), ".ateam", `cursor.${me}`); }
function fileCursor(me: string): CursorStore {
  return {
    read() { const f = cursorFile(me); return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null; },
    write(c) { mkdirSync(join(process.cwd(), ".ateam"), { recursive: true }); writeFileSync(cursorFile(me), c ?? ""); },
  };
}

function parseValue(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function common(a: Args): { refs?: string[]; writes?: string[] } {
  const out: { refs?: string[]; writes?: string[] } = {};
  const refs = list(a, "refs"); if (refs?.length) out.refs = refs;
  const writes = list(a, "writes"); if (writes?.length) out.writes = writes;
  return out;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

/**
 * t-105: this project's way of knowing what a task actually touched. The base is the branch's head at claim time,
 * kept beside the cursor in .ateam/ — local, never in the log, because it is this checkout's business. A checkout
 * with no git, or a task claimed before this existed, simply has no base, and the revision falls back to hand.
 */
function baseFile(task: string) { return join(process.cwd(), ".ateam", `base.${task}`); }
/** t-135: record where this round starts. `baseAt` decides; this only writes what it decided. */
function stampBase(task: string, op: "claim" | "reopen") {
  const next = baseAt(op, gitDiff().head(), gitDiff().base(task));
  if (!next) return;
  mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
  writeFileSync(baseFile(task), next + "\n");
}
function gitDiff(): Diff {
  const git = (args: string[]) => spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return {
    head: () => { const r = git(["rev-parse", "HEAD"]); return r.status === 0 ? r.stdout.trim() : null; },
    base: (task) => { try { return readFileSync(baseFile(task), "utf8").trim() || null; } catch { return null; } },
    // t-138: what this task changed, not what the branch did — a merge brings in other people's files, and merging
    // is what the seam rules ask for. The three questions and their blind spots live next to changedFiles.
    changed: (base) => changedFiles((args) => { const r = git(args); return r.status === 0 ? r.stdout : null; }, base),
  };
}

/** t-105: assemble the final touches for a done. `--no-touches` keeps the claim declaration as the final value. */
function touchesAtDone(task: string, declared: string[], extra: string[], keep: boolean, only = false): { touches: string[] | undefined; lines: string[]; measured: boolean } {
  if (keep) return { touches: undefined, lines: ["触点不改，沿用 claim 时声明的（--no-touches）"], measured: false };
  if (only) return revise(declared, null, extra, "", true);
  const d = gitDiff();
  const base = d.base(task);
  if (!base) return revise(declared, null, extra, `没记下 claim 起点：.ateam/base.${task} 不在，这件是这个功能之前 claim 的，或者这里没有 git`);
  const changed = d.changed(base);
  return revise(declared, changed, extra, changed === null ? `git 说不出 ${base.slice(0, 7)} 到现在改了什么` : `相对 claim 起点 ${base.slice(0, 7)}`);
}

async function main(argv: string[]) {
  const a = parse(argv);
  const [cmd, ...rest] = a._;
  if (!cmd || cmd === "help" || bool(a, "help")) { console.log(HELP); return; }

  if (cmd === "fixture") {
    exact(rest);
    console.log(await fixtureText({ start: str(a, "start"), stepMs: str(a, "step") !== undefined ? duration(str(a, "step")!) : undefined }));
    return;
  }

  if (cmd === "init" || cmd === "join") {
    exact(rest);
    const fields = initFields({ url: str(a, "url"), me: str(a, "me"), token: str(a, "token") }, process.env);
    mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(fields, null, 2) + "\n");
    const eff = resolveConfig(fields, process.env);
    console.log(`configured as "${eff.me}" against ${eff.url} (wrote ${Object.keys(fields).join(", ")} to .ateam/config.json). Add .ateam/ to .gitignore.`);
    // join: one sync (delivery is recorded, your presence begins), then the manual for the role
    const client = new Client(eff);
    const push = str(a, "push");
    if (push !== undefined) {
      if (!(PUSH_LEVELS as readonly string[]).includes(push)) throw new UsageError(`--push 只能是 ${PUSH_LEVELS.join(" | ")}`);
      const e = await client.emit({ kind: "reading", key: capabilityKey(eff.me), value: { push }, surface: NODE_SURFACE, method: "ateam join --push 自报" } as ClientEvent);
      console.log(fmt.event(e, eff.me));
    }
    await sync(client, eff.me, fileCursor(eff.me), 0, console.log).catch((err) => console.error(`sync: ${err instanceof Error ? err.message : err}`));
    console.log("");
    console.log(joinOutput(eff.me, await client.manual(eff.me)));
    return;
  }

  const cfg = loadConfig();
  const client = new Client(cfg);
  const emit = async (e: ClientEvent) => {
    const ev = await client.emit({ ...e, ...common(a) } as ClientEvent);
    console.log(`${ev.id}  ${fmt.event(ev, cfg.me)}`);
  };

  switch (cmd) {
    case "sync": {
      exact(rest);
      await sync(client, cfg.me, fileCursor(cfg.me), str(a, "wait") ? duration(str(a, "wait")!) : 0, bool(a, "quiet") ? null : console.log);
      return;
    }
    case "watch": {
      exact(rest);
      const interval = duration(str(a, "interval") ?? WATCH_INTERVAL);   // t-145: one number, from core
      const lockPath = join(process.cwd(), ".ateam", `watch.${cfg.me}.lock`);
      const other = blockingLock(lockPath, new Date(), 3 * interval);
      if (other && !bool(a, "force")) throw new UsageError(`another watch is already listening as ${cfg.me} in this checkout (pid ${other.pid}, heartbeat ${other.at}). Two watches replay old instructions to each other. Stop it first: kill ${other.pid}; or run with --force if it is really gone.`);
      const started = `ateam ${["watch", ...process.argv.slice(3).filter((x) => x !== "--force")].join(" ")}`; // t-102: what to re-run, in this node's own words
      const beat = () => writeLock(lockPath, process.pid, new Date(), started);
      beat();
      const release = () => removeLock(lockPath, process.pid);
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { release(); process.exit(130); });
      await watch(client, cfg.me, fileCursor(cfg.me), interval, console.log, { once: bool(a, "once"), heartbeat: beat });
      release();
      return;
    }
    case "ack": return emit({ kind: "ack", of: exact(rest, "id")[0] });
    case "untell": return emit({ kind: "untell", of: exact(rest, "id")[0], reason: str(a, "reason") ?? "" });
    case "board": {
      exact(rest);
      const b = await client.board(bool(a, "full"));
      console.log(bool(a, "json") ? JSON.stringify(b, null, 2) : fmt.board(b, cfg.me));
      return;
    }
    case "release": {
      exact(rest);
      let b = await client.board(true); // candidates and evidence live on the full board (t-070)
      const target = str(a, "deploy");
      if (target === undefined) {
        // t-078: measure with git which candidates production already contains, record it when it changed, then show the three groups
        const measured = containment(b, gitIsAncestor());
        const fact = containmentFact(b, measured);
        if (fact) { await emit(fact); b = await client.board(true); }
        else if (!measured) console.error(`（没有测包含关系：${b.release.deployed_sha ? "项目没有声明 absorb.form=git-ancestor" : "生产没有 deployed.sha 事实"}）`);
        if (measured?.unmeasured.length) console.error(`（git 判不出 ${measured.unmeasured.join("、")}：本地没有它们的证据 sha，先 git fetch 各分支）`);
        console.log(bool(a, "json") ? JSON.stringify(b.release, null, 2) : fmt.release(b));
        return;
      }
      const outcome = await deploy(b, target, {
        git: realGit(process.cwd(), process.env.ATEAM_DEPLOY_TOKEN), me: cfg.me, hasCredential: !!process.env.ATEAM_DEPLOY_TOKEN, anyway: str(a, "anyway"),
        reading: async (key, value, extra) => { await emit({ kind: "reading", key, value, surface: extra.surface, method: extra.method, writes: extra.writes } as ClientEvent); },
        note: async (body) => { await emit({ kind: "note", body }); },
        print: console.log,
      });
      if (outcome === "refused" || outcome === "failed") process.exitCode = 2;
      return;
    }
    case "trace": {
      const [target] = exact(rest, "task-id | sha");
      const { events } = await client.log(null);
      const lines = trace(events, target);
      if (!lines) throw new Error(isSha(target) ? `没有任务的完成证据里含 sha ${target}` : `日志里没有任务 ${target}（要按 sha 回溯请给 7–40 位十六进制）`);
      console.log(lines.join("\n"));
      return;
    }
    case "log": {
      exact(rest);
      const { events } = await client.log(str(a, "after") ?? null);
      for (const e of events) console.log(`${e.id}  ${fmt.event(e, cfg.me)}`);
      return;
    }
    case "tell": {
      const [to, body] = exact(rest, "to", "body");
      const intent = str(a, "kind") as InstructionIntent | undefined;
      if (to === "human" && !splitTitle(body).title) console.error(`提示：第一句超过 ${TITLE_MAX_CHARS} 字或没有句号，牌桌上这张卡没有标题。把要点写成第一句，用句号断开。`);
      return emit({ kind: "instruction", to, body, intent,
        ack_by: new Date(Date.now() + duration(str(a, "ack-by") ?? "15m")).toISOString(),
        options: list(a, "option"), default: str(a, "default") });
    }
    case "decide": {
      const [id, option] = exact(rest, "id", "option");
      const events = await decide({ board: () => client.board(), emit: (e) => client.emit({ ...e, ...common(a) } as ClientEvent) }, id, option);
      for (const ev of events) console.log(`${ev.id}  ${fmt.event(ev, cfg.me)}`);
      return;
    }
    case "reading": {
      const [key, value] = exact(rest, "key", "value");
      const validFor = str(a, "valid-for");
      const measuredAt = str(a, "measured-at") ? measuredAtOf(str(a, "measured-at")!, new Date()) : undefined;
      const from = measuredAt ? Date.parse(measuredAt) : Date.now();
      const shapeRe = str(a, "shape"), shapeEnum = list(a, "enum");
      const shape = shapeRe !== undefined || shapeEnum?.length ? { regex: shapeRe, enum: shapeEnum?.map(parseValue) } : undefined;
      return emit({ kind: "reading", key, value: parseValue(value),
        surface: need(str(a, "surface"), "--surface"), method: str(a, "method"), assumptions: list(a, "assumes"),
        depends_on: list(a, "depends-on"), valid_until: validFor ? new Date(from + duration(validFor)).toISOString() : undefined, shape, measured_at: measuredAt });
    }
    case "say": {
      const [text] = exact(rest, "正文");
      if (cfg.me !== "human") throw new UsageError(`say is the human's: you are ${cfg.me}. Put it in a note instead.`);
      if (text.trim().length > SAID_MAX_CHARS) throw new UsageError(`一句话最多 ${SAID_MAX_CHARS} 字（现在 ${text.trim().length}）；不够就再说一句`);
      return emit({ kind: "note", body: `${SAID_PREFIX}${text.trim()}` });
    }
    case "focus": return emit({ kind: "reading", key: "focus", surface: "team", value: exact(rest, "body")[0] });
    case "note": return emit({ kind: "note", body: exact(rest, "body")[0], decision: bool(a, "decision") || undefined, supersedes: str(a, "supersedes"), task: str(a, "task") });
    case "task": {
      const [op, id, ...more] = rest;
      const given = [id, ...more].filter((x): x is string => x !== undefined);
      if (op !== "create" && op !== "seam" && op !== "criteria") exact(given, "id"); // every other task op takes the id and nothing else
      switch (op) {
        case "show": {
          const { task: t, seams } = await client.task(need(id, "<id>")).catch((err) => { if (err instanceof ClientError && err.status === 404) throw new Error(`no task "${id}" in the log`); throw err; });
          // t-107: the same names the board shows; the role set comes from the board, one extra read
          const nb = await client.board().catch(() => null);
          console.log(fmt.task(t, seams, [], nb ? roleNamer(nb) : undefined)); // GET /task/<id> is the whole task: nothing omitted
          return;
        }
        case "create": {
          const [task, title] = exact([id, ...more].filter((x) => x !== undefined), "id", "title");
          const criteria = list(a, "criteria") ?? [];
          await emit({ kind: "task", op, task, title, criteria });
          console.log(fmt.created(title, criteria));
          return;
        }
        case "claim": {
          const t = need(id, "<id>");
          await emit({ kind: "task", op, task: t, touches: list(a, "touches") ?? [] });
          stampBase(t, "claim");   // t-105: remember where this branch stood, so done can measure what it touched
          return;
        }
        case "done": {
          const task = need(id, "<id>"), evidence = str(a, "evidence");
          // t-105: what this task actually touched, measured from the branch; --touches adds what a diff cannot see
          const rev = touchesAtDone(task, await client.task(task).then((x) => x.task.touches ?? []).catch(() => [] as string[]), list(a, "touches") ?? [], bool(a, "no-touches"), bool(a, "touches-only"));
          for (const line of rev.lines) console.error(line);
          if (bool(a, "no-seam-check")) console.error("跳过 seam 合并检查（--no-seam-check）");
          else {
            const b = await client.board();
            const check = seamCheck(b, task, evidence, gitIsAncestor());
            if (check.errors.length) throw new UsageError(check.errors.join("\n"));
            for (const u of check.unverified) console.error(`警告：${u}`);
            for (const w of seamWarnings(b, task, evidence, gitIsAncestor())) console.error(`警告：${w}`);
            await emit({ kind: "task", op, task, evidence, shows: str(a, "shows"), touches: rev.touches });
            // t-074: a fallback is never silent — what could not be verified goes on record next to the done
            if (check.unverified.length) await emit({ kind: "note", body: `接缝检查退回（无法验证吸收）：${check.unverified.join("；")}`, task });
            // t-073: seams this done settles by itself: recorded right after, with the basis
            for (const e of check.absorbs) await emit(e);
            return;
          }
          return emit({ kind: "task", op, task, evidence, shows: str(a, "shows") });
        }
        case "verify": {
          if (bool(a, "pass") === bool(a, "fail")) throw new Error("say --pass or --fail");
          return emit({ kind: "task", op, task: need(id, "<id>"), surface: str(a, "surface") ?? "", pass: bool(a, "pass"), evidence: str(a, "evidence"), shows: str(a, "shows") });
        }
        case "block": return emit({ kind: "task", op, task: need(id, "<id>"), on: str(a, "on") ?? "" });
        case "unblock": return emit({ kind: "task", op, task: need(id, "<id>") });
        case "withdraw": return emit({ kind: "task", op, task: need(id, "<id>"), reason: str(a, "reason") ?? "" });
        case "obsolete": return emit({ kind: "task", op, task: need(id, "<id>"), decision: str(a, "by") ?? "", reason: str(a, "reason") });
        case "reopen": {
          const t = need(id, "<id>");
          const e = await emit({ kind: "task", op, task: t, reason: str(a, "reason") ?? "" });
          stampBase(t, "reopen");   // t-135: a new round is measured from where the round started, not from the first claim
          return e;
        }
        case "criteria": {
          const [sub, task, text] = exact(given, "add", "id", "text");
          if (sub !== "add") throw new UsageError(`task criteria ${sub}: only "add" exists (criteria are never edited; ids are forever)`);
          return emit({ kind: "task", op, task, add: [text] });
        }
        case "seam": { const [x, y] = exact([id, ...more].filter((v) => v !== undefined), "a", "b"); return emit({ kind: "task", op, tasks: [x, y], resolution: str(a, "resolution") ?? "" }); }
        default: throw new Error(`unknown task op "${op}"`);
      }
    }
    default:
      throw new Error(`unknown command "${cmd}". Try: ateam help`);
  }
}

/**
 * t-102: after any command but `watch` itself, tell this node — and only this node — that its own watch stopped.
 * On stderr so `board --json` stays pipeable while a person still reads it at the end of the output. Best effort:
 * a node with no config, or no readable .ateam/, simply has nothing to say.
 */
/**
 * t-116: a refusal is visible for exactly one second — the moment it happens. At 01:11 I read a successful `tell` and
 * told two people a task was done; its `done` had been refused seconds earlier and I never looked back. So the node
 * writes down its last refusal and says it again on the next `sync` or `board`, until the same action goes through or
 * the person crosses it off. Local, like the deaf notice: no event, no log line — a refusal is this node's business.
 */
function refusalFile(me: string) { return join(process.cwd(), ".ateam", `refused.${me}`); }
function meOf(): string | null {
  try {
    const file = configFile();
    const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
    return process.env.ATEAM_ME || stored.me || null;
  } catch { return null; }
}
/** Called when a write is refused: remember it. Called after any command succeeds: cross off the one it redid. */
function noteRefusal(argv: string[], refusal: Refusal | null): void {
  try {
    const me = meOf();
    if (!me) return;
    const path = refusalFile(me);
    if (refusal) { mkdirSync(join(process.cwd(), ".ateam"), { recursive: true }); writeFileSync(path, JSON.stringify(refusal)); return; }
    // a success crosses off a refusal of the *same* action, and nothing else: redoing `task claim` does not clear a refused `task done`
    const st = readRefusal(existsSync(path) ? readFileSync(path, "utf8") : null);
    if (st.kind === "open" && st.refusal.what !== actionOf(argv)) return;
    if (existsSync(path)) rmSync(path, { force: true });
  } catch { /* the record is a convenience; never let it break the command */ }
}
/** The reminder itself, on the commands a turn starts with. `--clear-refused` crosses it off by hand. */
function sayIfRefused(argv: string[]): void {
  try {
    if (argv[0] !== "sync" && argv[0] !== "board") return;
    const me = meOf();
    if (!me) return;
    const path = refusalFile(me);
    if (argv.includes("--clear-refused")) { if (existsSync(path)) rmSync(path, { force: true }); console.error("已划掉上一次被拒的写入。"); return; }
    const line = refusalNotice(readRefusal(existsSync(path) ? readFileSync(path, "utf8") : null), new Date());
    if (line) console.error(line);
  } catch { /* same */ }
}

function sayIfDeaf(argv: string[]): void {
  try {
    if (argv[0] === "watch") return;
    const file = configFile();
    const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
    const me = process.env.ATEAM_ME || stored.me;   // just the identity: a half-configured node still deserves the reminder
    if (!me) return;
    const path = join(process.cwd(), ".ateam", `watch.${me}.lock`);
    // t-137: two ways of not listening, told apart. The heartbeat file says whether this node's own watch died; the
    // header the server sent says whether the server has seen it pull. Same place, same shape, never one verdict.
    const st = watchState(existsSync(path) ? readFileSync(path, "utf8") : null, new Date());
    for (const line of listeningNotices(st, pullIdle(seen.pullIdle))) console.error(line);
  } catch { /* never let the reminder break the command that carried it */ }
}

const ARGV = process.argv.slice(2);
main(ARGV).then(() => { noteRefusal(ARGV, null); sayIfRefused(ARGV); sayIfDeaf(ARGV); }).catch((err) => {
  // the reminders go last, after whatever this command had to say — including its failure
  const bye = (code: number, rule?: string) => {
    // quote what a shell would need quoted, so the line can be pasted back verbatim
    const shell = (a: string) => (/[\s"'$`\\]/.test(a) ? `"${a.replace(/(["\\$`])/g, "\\$1")}"` : a);
    if (rule) noteRefusal(ARGV, { at: new Date().toISOString(), rule, cmd: `ateam ${ARGV.map(shell).join(" ")}`, what: actionOf(ARGV) });
    sayIfRefused(ARGV);
    sayIfDeaf(ARGV);
    process.exit(code);
  };
  if (err instanceof ClientError) {
    console.error(err.status === 409 ? `REJECTED (${err.body.rule}): ${err.body.message}` : `server ${err.status}: ${err.message}`);
    return bye(err.status === 409 ? 2 : 1, err.status === 409 ? err.body.rule : undefined);
  }
  if (err instanceof ShapeError) { console.error(err.message); return bye(2); } // t-080: a newer server, said plainly
  if (err instanceof Rejected) { console.error(`REJECTED (${err.rule}): ${err.message}`); return bye(2, err.rule); }
  if (err instanceof UsageError) { console.error(`usage: ${err.message}`); return bye(2, "usage"); }
  console.error(err instanceof Error ? err.message : err);
  return bye(1);
});
