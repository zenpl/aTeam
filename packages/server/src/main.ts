import { createApp } from "./app.js";
import { SqliteStore } from "./sqlite-store.js";

const port = Number(process.env.PORT ?? 8080);
const db = process.env.ATEAM_DB ?? "./data/ateam.db";
const token = process.env.ATEAM_TOKEN;
const human = process.env.ATEAM_HUMAN ?? "human";

if (!token) console.warn("ATEAM_TOKEN is not set: the server is open. Fine locally, not on the internet.");

const app = createApp({ store: new SqliteStore(db), token, human });
app.listen(port, () => console.log(`ateam server on :${port} db=${db} human=${human}`));
