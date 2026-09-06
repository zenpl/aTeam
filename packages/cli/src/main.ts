import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardTask, type ClientEvent } from "@ateam/core";
import { parse, str, list, bool, duration, type Args } from "./args.js";
import { Client, ClientError } from "./client.js";
import { resolveConfig, initFields, type Config } from "./config.js";
import * as fmt from "./format.js";
import { sync, watch, type CursorStore } from "./loop.js";

const HELP = `ateam — the shared log for a team of sessions

setup
  ateam init --me <role> [--url <server>] [--token <t>]   writes the given fields to .ateam/config.json
                                                          precedence per field: env ATEAM_ME / ATEAM_URL / ATEAM_TOKEN beats the file; the file fills what the env leaves unset

every turn
  ateam sync [--wait 25s]        pull new events since your cursor; instructions for you are marked. --wait long-polls.
  ateam ack <id>                 acknowledge an instruction addressed to you
  ateam board [--json]           what is true, what is open, who is here

say things
  ateam tell <to> <body> [--ack-by 15m]                              instruction: one recipient, ≤280 chars, must be acked
  ateam tell human <body> --option A --option B [--default B]        a decision for the human; the board shows one button per option
  ateam decide <id> <option>                                         choose for an instruction with options: acks it and records the decision
  ateam reading <key> <value> --surface <s> [--depends-on a,b] [--assumes "..."]... [--valid-for 6h] [--method m]
                                    [--shape <regex>] [--enum a,b,c]   declare once what values <key> may take; later mismatches are rejected
  ateam focus <body>                                                 the one thing that matters most right now
  ateam note <body> [--decision] [--supersedes <id>]

tasks
  ateam task show <id>                       title, status, owner, criteria, touches, evidence, verifications, seams
  ateam task create <id> <title> --criteria "..." [--criteria "..."]
  ateam task claim <id> --touches a,b        declare the paths/symbols/fields you will change
  ateam task done <id> [--evidence "..."]
  ateam task verify <id> --surface <s> (--pass|--fail) [--evidence "..."]
  ateam task block <id> --on "..." | ateam task unblock <id>
  ateam task withdraw <id> --reason "..."   terminal; only open/blocked tasks, by the criteria author, pm or human
  ateam task seam <a> <b> --resolution "..."

any emit accepts --refs <ids> (what you build on; stale readings are rejected) and --writes <surface:key,...> (what you changed).

  ateam log [--after <id>]       raw events
  ateam watch [--interval 20s]   loop sync, printing what arrives; exits 0 when an instruction for you arrives (for Monitor)
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

async function main(argv: string[]) {
  const a = parse(argv);
  const [cmd, ...rest] = a._;
  if (!cmd || cmd === "help" || bool(a, "help")) { console.log(HELP); return; }

  if (cmd === "init") {
    const fields = initFields({ url: str(a, "url"), me: str(a, "me"), token: str(a, "token") }, process.env);
    mkdirSync(join(process.cwd(), ".ateam"), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(fields, null, 2) + "\n");
    const eff = resolveConfig(fields, process.env);
    console.log(`configured as "${eff.me}" against ${eff.url} (wrote ${Object.keys(fields).join(", ")} to .ateam/config.json). Add .ateam/ to .gitignore.`);
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
      await sync(client, cfg.me, fileCursor(cfg.me), str(a, "wait") ? duration(str(a, "wait")!) : 0, bool(a, "quiet") ? null : console.log);
      return;
    }
    case "watch": {
      await watch(client, cfg.me, fileCursor(cfg.me), duration(str(a, "interval") ?? "20s"), console.log);
      return;
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
        ack_by: new Date(Date.now() + duration(str(a, "ack-by") ?? "15m")).toISOString(),
        options: list(a, "option"), default: str(a, "default") });
    }
    case "decide": {
      const [id, ...option] = rest;
      const of = need(id, "<id>"), choice = need(option.join(" "), "<option>");
      const b = await client.board();
      const i = b.instructions.find((x) => x.id === of);
      if (!i) throw new Error(`no instruction "${of}" in the log`);
      if (i.status !== "acked") await emit({ kind: "ack", of });
      return emit({ kind: "note", body: `decision: ${i.body} -> ${choice}`, decision: true, decides: { of, option: choice } });
    }
    case "reading": {
      const [key, ...value] = rest;
      const validFor = str(a, "valid-for");
      const shapeRe = str(a, "shape"), shapeEnum = list(a, "enum");
      const shape = shapeRe !== undefined || shapeEnum?.length ? { regex: shapeRe, enum: shapeEnum?.map(parseValue) } : undefined;
      return emit({ kind: "reading", key: need(key, "<key>"), value: parseValue(need(value.join(" "), "<value>")),
        surface: need(str(a, "surface"), "--surface"), method: str(a, "method"), assumptions: list(a, "assumes"),
        depends_on: list(a, "depends-on"), valid_until: validFor ? new Date(Date.now() + duration(validFor)).toISOString() : undefined, shape });
    }
    case "focus": return emit({ kind: "reading", key: "focus", surface: "team", value: need(rest.join(" "), "<body>") });
    case "note": return emit({ kind: "note", body: need(rest.join(" "), "<body>"), decision: bool(a, "decision") || undefined, supersedes: str(a, "supersedes") });
    case "task": {
      const [op, id, ...more] = rest;
      switch (op) {
        case "show": {
          const b = await client.board();
          const t = boardTask(b, need(id, "<id>"));
          if (!t) throw new Error(`no task "${id}" in the log`);
          console.log(fmt.task(t, b.seams));
          return;
        }
        case "create": return emit({ kind: "task", op, task: need(id, "<id>"), title: need(more.join(" "), "<title>"), criteria: list(a, "criteria") ?? [] });
        case "claim": return emit({ kind: "task", op, task: need(id, "<id>"), touches: list(a, "touches") ?? [] });
        case "done": return emit({ kind: "task", op, task: need(id, "<id>"), evidence: str(a, "evidence") });
        case "verify": {
          if (bool(a, "pass") === bool(a, "fail")) throw new Error("say --pass or --fail");
          return emit({ kind: "task", op, task: need(id, "<id>"), surface: str(a, "surface") ?? "", pass: bool(a, "pass"), evidence: str(a, "evidence") });
        }
        case "block": return emit({ kind: "task", op, task: need(id, "<id>"), on: str(a, "on") ?? "" });
        case "unblock": return emit({ kind: "task", op, task: need(id, "<id>") });
        case "withdraw": return emit({ kind: "task", op, task: need(id, "<id>"), reason: str(a, "reason") ?? "" });
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
