/**
 * Where the CLI's identity and server come from. Pure: main.ts does the file and env reading.
 * Precedence for each field: environment, then .ateam/config.json. `ateam init` writes only what it was given,
 * so a session that exports ATEAM_URL/ATEAM_TOKEN needs nothing but `ateam init --me <role>`.
 */
export interface Config { url: string; token?: string; me: string; /** the project the url names (/p/<id>), if any */ project?: string }

/** The project id a service address names, when it carries the /p/<id> prefix. */
export function projectOf(url: string | undefined): string | undefined {
  const m = /\/p\/([^/?#]+)\/?(?:[?#].*)?$/.exec(url ?? "");
  return m ? decodeURIComponent(m[1]) : undefined;
}
export type Env = Partial<Record<"ATEAM_URL" | "ATEAM_ME" | "ATEAM_TOKEN", string>>;

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function resolveConfig(file: Partial<Config>, env: Env): Config {
  const url = blank(env.ATEAM_URL) ?? blank(file.url);
  const me = blank(env.ATEAM_ME) ?? blank(file.me);
  const token = blank(env.ATEAM_TOKEN) ?? blank(file.token);
  const missing: string[] = [];
  if (!me) missing.push("identity: run `ateam init --me <role>` or `export ATEAM_ME=<role>`");
  if (!url) missing.push("server: run `ateam init --url <server>` or `export ATEAM_URL=<server>`");
  if (missing.length) throw new Error(`not configured. Missing ${missing.join("; ")}`);
  return { url: url!, me: me!, token, project: projectOf(url) ?? blank(file.project) };
}

/** What `ateam init` writes: exactly the fields given on the command line, nothing copied from env. */
export function initFields(flags: { url?: string; me?: string; token?: string }, env: Env): Partial<Config> {
  const out: Partial<Config> = {};
  if (blank(flags.url)) out.url = flags.url!.trim();
  if (blank(flags.me)) out.me = flags.me!.trim();
  if (blank(flags.token)) out.token = flags.token!.trim();
  if (!out.me) throw new Error("init: --me <role> is required (pm, dev, qa, ...)");
  if (!out.url && !blank(env.ATEAM_URL)) throw new Error("init: pass --url <server> or set ATEAM_URL");
  const project = projectOf(out.url ?? env.ATEAM_URL);
  if (project) out.project = project;
  return out;
}

/** What `ateam join` prints after the manual: where the project's own file is, if the checkout has one. */
export const JOIN_FOOTER = "项目档案见 docs/self.md（若仓库有）";

/** The join screen: the manual for the role (or a note that the server has none), then the footer, always last. */
export function joinOutput(role: string, manual: string | null): string {
  const body = manual ?? `服务器没有 ${role} 这个角色的说明书；项目档案会说这个角色是什么。`;
  return `${body.trimEnd()}\n\n${JOIN_FOOTER}`;
}
