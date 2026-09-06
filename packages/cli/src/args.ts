export interface Args {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

const BOOLEAN = new Set(["pass", "fail", "decision", "json", "help", "quiet", "no-seam-check", "once"]);
const REPEATABLE = new Set(["criteria", "assumes", "option"]);

export function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let value: string | boolean;
    if (eq > 0) value = a.slice(eq + 1);
    else if (BOOLEAN.has(name)) value = true;
    else { value = argv[++i]; if (value === undefined) throw new Error(`--${name} needs a value`); }
    if (REPEATABLE.has(name)) {
      const arr = (out.flags[name] as string[] | undefined) ?? [];
      arr.push(String(value));
      out.flags[name] = arr;
    } else out.flags[name] = value;
  }
  return out;
}

export function str(a: Args, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === "string" ? v : undefined;
}
export function list(a: Args, name: string): string[] | undefined {
  const v = a.flags[name];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
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
