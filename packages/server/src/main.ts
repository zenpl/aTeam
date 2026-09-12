import { createApp, parseOffset } from "./app.js";
import { SqliteDb, SqliteStore, SqliteRegistry, recordBackup } from "./sqlite-store.js";

const port = Number(process.env.PORT ?? 8080);
const db = process.env.ATEAM_DB ?? "./data/ateam.db";
const token = process.env.ATEAM_TOKEN;
const human = process.env.ATEAM_HUMAN ?? "human";
const sha = process.env.ATEAM_SHA || "unknown";
// Decision (human, 06:23): the board is public read-only for now; ATEAM_BOARD_PUBLIC=0 makes it need the token again.
const boardPublic = !/^(0|false|no)$/i.test(process.env.ATEAM_BOARD_PUBLIC ?? "1");
// t-041: the unprefixed address means this project; the log that predates projects is migrated into it on first start.
const defaultProject = process.env.ATEAM_DEFAULT_PROJECT ?? "ateam";
// t-063: test hooks exist only where the environment says so; production never sets ATEAM_TEST_HOOKS.
const testHooks = /^(1|true|yes)$/i.test(process.env.ATEAM_TEST_HOOKS ?? "");
const clockOffsetMs = testHooks ? (parseOffset(process.env.ATEAM_TEST_CLOCK_OFFSET ?? "0") || 0) : 0;
if (testHooks) console.warn(`ATEAM_TEST_HOOKS is on: POST /_test/clock and /_test/run are live (offset ${clockOffsetMs} ms). Never in production.`);

if (!token) console.warn("ATEAM_TOKEN is not set: the default project is open. Fine locally, not on the internet.");

let sdb: SqliteDb;
try { sdb = new SqliteDb(db, defaultProject); }
catch (err) { console.error(String((err as Error).message)); process.exit(1); }
if (sdb.backup) {
  console.log(`backup before migration ${sdb.backup.migration}: ${sdb.backup.path} (${sdb.backup.bytes} bytes)`);
  await recordBackup(new SqliteStore(sdb, defaultProject), sdb.backup, human);
}
const app = createApp({
  registry: new SqliteRegistry(sdb), storeFor: (project) => new SqliteStore(sdb, project),
  defaultProject, token, human, sha, boardPublic,
  publicUrl: process.env.ATEAM_PUBLIC_URL,
  // t-234 判据 9：发出主人地址要的那段口令，只从环境来；不设就是这扇门关着
  ownerSecret: process.env.ATEAM_OWNER_SECRET,
  testHooks, clockOffsetMs,
});
app.listen(port, () => console.log(`ateam server on :${port} db=${db} default=${defaultProject} human=${human} sha=${sha} board=${boardPublic ? "public" : "token"}`));
