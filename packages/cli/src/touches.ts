/**
 * t-105 (T4): touches declared at claim are a guess; touches at done are a fact. This is the *project* layer — this
 * project keeps its work in git, so the fact comes from the branch's own diff. The platform knows none of that: it
 * only reads the final list off the done event (see the `done` op in core). A medium with no diff falls back to the
 * person revising the list by hand, and that path is a first-class one, not a "later".
 */
export interface Diff {
  /** The sha this branch was at when the task was claimed, if we recorded it. */
  base(task: string): string | null;
  /** Files changed between `base` and the working tree now, or null when git cannot say. */
  changed(base: string): string[] | null;
  /** The current commit, to record as a base at claim time. Null when there is no git here. */
  head(): string | null;
}

export interface Revision {
  /** What goes on the done event. `undefined` says nothing, and the claim declaration stands. */
  touches: string[] | undefined;
  /** Lines for the person: what the diff added, what it dropped, and where the value came from. */
  lines: string[];
  /** True when the list came from the diff; false when the person supplied it (no git, no base, or --touches only). */
  measured: boolean;
}

/**
 * Is this entry something a diff could have measured? Only a path is: it has a directory separator, no `#symbol`
 * suffix and no spaces. Everything else — `deployed.sha`, `GET /health`, a bare symbol — the diff never saw, so the
 * revision keeps it rather than silently dropping the seams it carries.
 */
const isPath = (x: string) => x.includes("/") && !x.includes("#") && !/\s/.test(x);

/**
 * The final list. `declared` is what claim said, `changed` what the diff measured (null when it could not), `extra`
 * what the person added by hand. Measured paths replace the declared *paths*; everything the diff cannot see
 * (symbols, field names, `GET /health`) is kept, because dropping it would silently drop the seams it carries.
 */
export function revise(declared: string[], changed: string[] | null, extra: string[], why: string, only = false): Revision {
  if (only) {
    // The person is saying "this list is the fact". A diff measures a branch, not a task: one branch carrying three
    // tasks in a row measures all three every time, and no amount of measuring can tell them apart. When they know
    // and the measurement cannot, they say so and it stands.
    const mine = [...new Set(extra.map((x) => x.trim()).filter(Boolean))];
    const gone = [...new Set(declared.map((x) => x.trim()).filter(Boolean))].filter((x) => !mine.includes(x));
    return { touches: mine, measured: false,
      lines: [`触点按你写的这 ${mine.length} 条算，量出来的不作数（--touches-only）`, ...(gone.length ? [`  claim 时声明了、这次没写：${gone.join("、")}`] : [])] };
  }
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const dec = clean(declared), ext = clean(extra);
  if (changed === null) {
    // Nothing measured: what the person wrote *is* the fact, and it replaces the declaration (说明书第 7 步：覆盖
    // claim 时那份). Writing nothing means they are standing by the declaration, which is a choice, not a mistake.
    const touches = ext.length ? ext : dec;
    const lines = [`触点没法量（${why}）。${ext.length ? `按你写的实际碰到的算，覆盖 claim 时那份：${ext.join("、")}` : "你没写 --touches，沿用 claim 时声明的那份"}`];
    if (ext.length) {
      const gone = dec.filter((x) => !ext.includes(x));
      if (gone.length) lines.push(`  claim 时声明了、这次没写：${gone.join("、")}`);
    }
    return { touches, lines, measured: false };
  }
  const measured = clean(changed);
  if (!measured.length && dec.length && !ext.length) {
    // git looked and found nothing changed since the claim point. That may be true (nothing saved yet) or a sign the
    // base is wrong. Either way, wiping a declaration on the strength of it would delete real seams, so say what
    // happened and leave the declaration standing — printed and recorded agree (qa 00:29 caught them disagreeing).
    return { touches: undefined, lines: [`量出 0 个改动文件（${why}）：先不改触点，沿用 claim 时声明的 ${dec.length} 条。真的什么都没碰就不必管；碰了却没量到，先把改动落盘，或用 --touches 直接写实际碰到的`], measured: false };
  }
  const kept = dec.filter((x) => !isPath(x));                       // symbols and the like: the diff never saw them
  const touches = clean([...measured, ...kept, ...ext]);
  const added = measured.filter((x) => !dec.includes(x));
  const dropped = dec.filter((x) => isPath(x) && !measured.includes(x));
  const lines = [`触点按量出来的实际改动改成 ${measured.length} 个文件（${why}）`];
  if (added.length) lines.push(`  claim 时没声明、实际改了：${added.join("、")}`);
  if (dropped.length) lines.push(`  claim 时声明了、实际没改：${dropped.join("、")}`);
  if (kept.length) lines.push(`  diff 看不见、保留声明的：${kept.join("、")}`);
  if (ext.length) lines.push(`  你补的：${ext.join("、")}`);
  if (!added.length && !dropped.length) lines.push("  与 claim 时声明的一致");
  return { touches, lines, measured: true };
}
