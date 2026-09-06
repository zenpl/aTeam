import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientEvent } from "@ateam/core";
import { parse, str, list, bool, duration, type Args } from "./args.js";
import { Client, ClientError, type Config } from "./client.js";
import * as fmt from "./format.js";

const HELP = `ateam — the shared log for a team of sessions

setup
  ateam init --url <server> --me <name> [--token <t>]     writes .ateam/config.json (or use ATEAM_URL/ATEAM_ME/ATEAM_TOKEN)

every turn
  ateam sync [--wait 25s]        pull new events since your cursor; instructions for you are marked. --wait long-polls.
  ateam ack <id>                 acknowledge an instruction addressed to you
  ateam board [--json]           what is true, what is open, who is here

say things
  ateam tell <to> <body> [--ack-by 15m]                              instruction: one recipient, ≤280 chars, must be acked
  ateam reading <key> <value> --surface <s> [--depends-on a,b] [--assumes "..."]... [--valid-for 6h] [--method m]
  ateam focus <body>                                                 the one thing that matters most right now
  ateam note <body> [--decision] [--supersedes <id>]

tasks
  ateam task create <id> <title> --criteria "..." [--criteria "..."]
  ateam task claim <id> --touches a,b        declare the paths/symbols/fields you will change
  ateam task done <id> [--evidence "..."]
  ateam task verify <id> --surface <s> (--pass|--fail) [--evidence "..."]
  ateam task block <id> --on "..." | ateam task unblock <id>
  ateam task seam <a> <b> --resolution "..."

any emit accepts --refs <ids> (what you build on; stale readings are rejected) and --writes <surface:key,...> (what you changed).

  ateam log [--after <id>]       raw events
  ateam watch [--interval 20s]   loop sync; exits 0 when an instruction for you arrives (for Monitor)
`;

function loadConfig(): Config {
  const file = join(process.cwd(), ".ateam", "config.json");
  const f = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
  const url = process.env.ATEAM_URL ?? f.url;
  const me = process.env.ATEAM_ME ?? f.me;
  const token = process.env.ATEAM_TOKEN ?? f.token;
  if (!url || !me) throw new Error("not configured: run `ateam init --url <server> --me <name>` or set ATEAM_URL and ATEAM_ME");
  return { url, me, token };
}

function cursorFile(me: string) { return join(process.cwd(), ".ateam", `cursor.${me}`); }
function readCursor(me: string): string | null {
  const f = cursorFile(me);
  return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
}
function writeCursor(me: string, c: string | null) {
  mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
  writeFileSync(cursorFile(me), c ?? "");
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

async function sync(client: Client, cfg: Config, waitMs: number, quiet: boolean): Promise<number> {
  const after = readCursor(cfg.me);
  const r = await client.pull(after, waitMs);
  writeCursor(cfg.me, r.cursor);
  if (!quiet) {
    if (!r.events.length) console.log(after ? "nothing new" : "log is empty");
    for (const e of r.events) console.log(fmt.event(e, cfg.me));
    if (r.for_me.length) console.log(`\n${r.for_me.length} instruction(s) for you. Ack each with: ateam ack <id>`);
  }
  return r.for_me.length;
}

async function main(argv: string[]) {
  const a = parse(argv);
  const [cmd, ...rest] = a._;
  if (!cmd || cmd === "help" || bool(a, "help")) { console.log(HELP); return; }

  if (cmd === "init") {
    const cfg: Config = { url: need(str(a, "url"), "--url"), me: need(str(a, "me"), "--me"), token: str(a, "token") };
    mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
    writeFileSync(join(process.cwd(), ".ateam", "config.json"), JSON.stringify(cfg, null, 2));
    console.log(`configured as "${cfg.me}" against ${cfg.url}. Add .ateam/ to .gitignore.`);
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
      await sync(client, cfg, str(a, "wait") ? duration(str(a, "wait")!) : 0, bool(a, "quiet"));
      return;
    }
    case "watch": {
      const interval = duration(str(a, "interval") ?? "20s");
      for (;;) {
        const n = await sync(client, cfg, Math.min(interval, 30_000), true);
        if (n > 0) { await sync(client, cfg, 0, false).catch(() => {}); console.log("\ninstruction received"); return; }
      }
    }
    case "ack": return emit({ kind: "ack", of: need(rest[0], "<id>") });
    case "board": {
      const b = await client.board();
      console.log(bool(a, "json") ? JSON.stringify(b, null, 2) : fmt.board(b, cfg.me));
      return;
    }
    case "log": {
      const { events } = await client.log(str(a, "after") ?? null);
      for (const e of events) console.log(`${e.id}  ${fmt.event(e, cfg.me)}`);
      return;
    }
    case "tell": {
      const [to, ...body] = rest;
      return emit({ kind: "instruction", to: need(to, "<to>"), body: need(body.join(" "), "<body>"),
        ack_by: new Date(Date.now() + duration(str(a, "ack-by") ?? "15m")).toISOString() });
    }
    case "reading": {
      const [key, ...value] = rest;
      const validFor = str(a, "valid-for");
      return emit({ kind: "reading", key: need(key, "<key>"), value: parseValue(need(value.join(" "), "<value>")),
        surface: need(str(a, "surface"), "--surface"), method: str(a, "method"), assumptions: list(a, "assumes"),
        depends_on: list(a, "depends-on"), valid_until: validFor ? new Date(Date.now() + duration(validFor)).toISOString() : undefined });
    }
    case "focus": return emit({ kind: "reading", key: "focus", surface: "team", value: need(rest.join(" "), "<body>") });
    case "note": return emit({ kind: "note", body: need(rest.join(" "), "<body>"), decision: bool(a, "decision") || undefined, supersedes: str(a, "supersedes") });
    case "task": {
      const [op, id, ...more] = rest;
      switch (op) {
        case "create": return emit({ kind: "task", op, task: need(id, "<id>"), title: need(more.join(" "), "<title>"), criteria: list(a, "criteria") ?? [] });
        case "claim": return emit({ kind: "task", op, task: need(id, "<id>"), touches: list(a, "touches") ?? [] });
        case "done": return emit({ kind: "task", op, task: need(id, "<id>"), evidence: str(a, "evidence") });
        case "verify": {
          if (bool(a, "pass") === bool(a, "fail")) throw new Error("say --pass or --fail");
          return emit({ kind: "task", op, task: need(id, "<id>"), surface: str(a, "surface") ?? "", pass: bool(a, "pass"), evidence: str(a, "evidence") });
        }
        case "block": return emit({ kind: "task", op, task: need(id, "<id>"), on: str(a, "on") ?? "" });
        case "unblock": return emit({ kind: "task", op, task: need(id, "<id>") });
        case "seam": return emit({ kind: "task", op, tasks: [need(id, "<a>"), need(more[0], "<b>")], resolution: str(a, "resolution") ?? "" });
        default: throw new Error(`unknown task op "${op}"`);
      }
    }
    default:
      throw new Error(`unknown command "${cmd}". Try: ateam help`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof ClientError) {
    console.error(err.status === 409 ? `REJECTED (${err.body.rule}): ${err.body.message}` : `server ${err.status}: ${err.message}`);
    process.exit(err.status === 409 ? 2 : 1);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
