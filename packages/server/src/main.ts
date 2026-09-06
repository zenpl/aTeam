import { createApp } from "./app.js";
import { SqliteDb, SqliteStore, SqliteRegistry } from "./sqlite-store.js";

const port = Number(process.env.PORT ?? 8080);
const db = process.env.ATEAM_DB ?? "./data/ateam.db";
const token = process.env.ATEAM_TOKEN;
const human = process.env.ATEAM_HUMAN ?? "human";
const sha = process.env.ATEAM_SHA || "unknown";
// Decision (human, 06:23): the board is public read-only for now; ATEAM_BOARD_PUBLIC=0 makes it need the token again.
const boardPublic = !/^(0|false|no)$/i.test(process.env.ATEAM_BOARD_PUBLIC ?? "1");
// t-041: the unprefixed address means this project; the log that predates projects is migrated into it on first start.
const defaultProject = process.env.ATEAM_DEFAULT_PROJECT ?? "ateam";

if (!token) console.warn("ATEAM_TOKEN is not set: the default project is open. Fine locally, not on the internet.");

const sdb = new SqliteDb(db, defaultProject);
const app = createApp({
  registry: new SqliteRegistry(sdb), storeFor: (project) => new SqliteStore(sdb, project),
  defaultProject, token, human, sha, boardPublic,
});
app.listen(port, () => console.log(`ateam server on :${port} db=${db} default=${defaultProject} human=${human} sha=${sha} board=${boardPublic ? "public" : "token"}`));
