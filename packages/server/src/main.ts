import { createApp } from "./app.js";
import { SqliteStore } from "./sqlite-store.js";

const port = Number(process.env.PORT ?? 8080);
const db = process.env.ATEAM_DB ?? "./data/ateam.db";
const token = process.env.ATEAM_TOKEN;
const human = process.env.ATEAM_HUMAN ?? "human";
const sha = process.env.ATEAM_SHA || "unknown";
// Decision (human, 06:23): the board is public read-only for now; ATEAM_BOARD_PUBLIC=0 makes it need the token again.
const boardPublic = !/^(0|false|no)$/i.test(process.env.ATEAM_BOARD_PUBLIC ?? "1");

if (!token) console.warn("ATEAM_TOKEN is not set: the server is open. Fine locally, not on the internet.");

const app = createApp({ store: new SqliteStore(db), token, human, sha, boardPublic });
app.listen(port, () => console.log(`ateam server on :${port} db=${db} human=${human} sha=${sha} board=${boardPublic ? "public" : "token"}`));
