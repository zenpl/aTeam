/**
 * t-234：**用例要拿主人自己那把钥匙，不再借管理钥匙。**
 *
 * 在此之前，「主人还没到过」的那段窗口里管理钥匙可以代人说话，于是几乎每一份 HTML 用例都用 `?token=<管理钥匙>`
 * 拿一个 cookie 就去点人的按钮。**那个窗口从来没关上过**（本项目五天 `owner_key.state` 一直是 `none`），
 * 它正是 qa 17:05 量到的洞。
 *
 * 这里走的是**生产上同一条路**，不是测试专用的后门：持管理钥匙的节点问 `GET /owner-url` 要回主人的地址
 * （钥匙是推导出来的，所以是同一个地址，不是新发一个），再打开那个地址——主人第一次打开，就是升级完成的那一刻。
 */
/** t-234 判据 9：发出主人地址要的那段口令，只在服务环境里。用例起的服务都用这一段。 */
export const TEST_OWNER_SECRET = "ops-only-secret";

export async function ownerKey(base: string, token: string, secret: string = TEST_OWNER_SECRET): Promise<string> {
  const r = await fetch(`${base}/owner-url`, { headers: { authorization: `Bearer ${token}`, "x-owner-secret": secret } });
  if (!r.ok) throw new Error(`/owner-url ${r.status}: ${await r.text()}`);
  const { board_url: url } = (await r.json()) as { board_url: string };
  const k = new URL(url).searchParams.get("k");
  if (!k) throw new Error(`/owner-url 给的地址里没有 k=：${url}`);
  return k;
}

export async function ownerCookie(base: string, token: string, secret: string = TEST_OWNER_SECRET): Promise<string> {
  const k = await ownerKey(base, token, secret);
  const open = await fetch(`${base}/?k=${encodeURIComponent(k)}`, { redirect: "manual" });
  const set = open.headers.get("set-cookie");
  if (!set) throw new Error(`打开主人地址没有拿到 cookie（${open.status}）`);
  return set.split(";")[0];
}

/**
 * t-234：**不走 HTTP 拿主人那把钥匙。** `/owner-url` 会顺手往日志里写一条 `entry.form` 事实（它该写），
 * 而有几份用例数的正是「日志此刻有几条」「这一页上有没有英文」。钥匙是从项目算出来的，所以这里问登记处
 * 要到的，与那条 HTTP 路给的是同一把。**它不是后门**：拿到之后照样走真闸——服务端认的是钥匙，不是谁在问。
 */
export async function ownerKeyOf(registry: { ownerKey(project: string, human: string): Promise<{ key: string }> }, project: string, human: string): Promise<string> {
  return (await registry.ownerKey(project, human)).key;
}
