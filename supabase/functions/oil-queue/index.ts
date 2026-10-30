// 油品排隊登記 API（Supabase Edge Function：oil-queue）
// 客人：LIFF 登記頁帶 LINE idToken 呼叫 register / me / cancel
// 門市：後台帶密碼呼叫 admin_*（名單、放量通知、查取貨碼、兌換、取消、重發通知）；員工密碼只能兌換、看名單
// Secrets：OIL_LIFF_ID（LIFF ID，前半段就是 LINE Login 頻道 ID）、OIL_ADMIN_PASSWORD（管理者密碼）、
//          OIL_STAFF_PASSWORD（員工密碼）、
//          LINE_CHANNEL_ACCESS_TOKEN（叫貨官方帳號，line-webhook 已設好，同專案共用）
// 部署時關閉 JWT 驗證（LIFF 頁面不會帶 Supabase 金鑰，身分改用 LINE idToken／後台密碼驗證）
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const LIFF_ID = Deno.env.get("OIL_LIFF_ID") ?? "";
const LOGIN_CHANNEL = LIFF_ID.split("-")[0];
const LIFF_URL = `https://liff.line.me/${LIFF_ID}`;
const ADMIN_PW = Deno.env.get("OIL_ADMIN_PASSWORD") ?? "";
const STAFF_PW = Deno.env.get("OIL_STAFF_PASSWORD") ?? "";
const STAFF_ACTIONS = ["admin_login", "admin_list", "admin_lookup", "admin_redeem"]; // 員工密碼只能兌換、看名單
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";

const PRODUCTS = ["沙拉油", "耐炸油"];
const PICKUP_DAYS = 2;   // 通知後幾個營業日內取貨（週日不算）
const COOLDOWN_DAYS = 10; // 取貨後幾天內不能再登記
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉 0/O、1/I/L 容易看錯的字
const WEEK = "日一二三四五六";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

class UserError extends Error {}

// ── 時間（台灣 UTC+8）──────────────────────────────
const TW = 8 * 3600 * 1000;

function deadlineFrom(now: Date): Date {
  // 通知當天不算，往後數 PICKUP_DAYS 個營業日（跳過週日），期限是那天台灣時間 23:59:59
  const d = new Date(now.getTime() + TW);
  let n = 0;
  while (n < PICKUP_DAYS) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0) n++;
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59) - TW);
}

function twDate(iso: string | Date): string { // 11/3（一）
  const d = new Date(new Date(iso).getTime() + TW);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`;
}

// ── 共用 ──────────────────────────────────────────
async function expireOverdue() {
  // 過了取貨期限還沒兌換的，改成已逾期（每次呼叫先跑一次，不用排程）
  await db.from("oil_queue").update({ status: "已逾期" })
    .eq("status", "已通知").lt("deadline", new Date().toISOString());
}

async function lineUser(idToken: string): Promise<{ userId: string; name: string }> {
  if (!idToken || !LOGIN_CHANNEL) throw new UserError("登入資訊錯誤，請重新打開頁面");
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LOGIN_CHANNEL }),
  });
  if (!r.ok) throw new UserError("登入已過期，請關閉頁面後重新掃描 QR Code");
  const p = await r.json();
  return { userId: p.sub, name: p.name ?? "" };
}

async function position(row: { id: number; product: string }): Promise<number> {
  const { count } = await db.from("oil_queue").select("id", { count: "exact", head: true })
    .eq("product", row.product).eq("status", "排隊中").lte("id", row.id);
  return count ?? 0;
}

function newCode(): string {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

async function pushText(userId: string, text: string, tag: unknown): Promise<boolean> {
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
    });
    if (!r.ok) console.error("LINE 推播失敗", tag, r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("LINE 推播失敗", tag, e);
    return false;
  }
}

async function pushConfirm(row: Record<string, any>): Promise<boolean> {
  // 登記確認：查詢連結留在客人的聊天室，忘了網址也查得到
  const text = `【惠通行】${row.name} 您好，已收到您的油品排隊登記✅\n\n` +
    `品項：${row.product} 1 桶\n` +
    `目前順位：第 ${row.position} 位\n\n` +
    `到貨輪到您時，會再用 LINE 通知您取貨。\n` +
    `👉 隨時查詢目前順位：${LIFF_URL}\n\n` +
    `※ 品牌無法指定（大成／美食家），依當次到貨品牌出貨\n` +
    `※ 請勿封鎖本帳號，以免收不到到貨通知`;
  return pushText(row.user_id, text, row.id);
}

async function pushNotice(row: Record<string, any>): Promise<boolean> {
  const text = `【惠通行】${row.name} 您好，您登記的「${row.product}」已到貨🎉\n\n` +
    `取貨碼：${row.code}\n` +
    `⏰ 取貨期限：通知後 ${PICKUP_DAYS} 個營業日內\n` +
    `請於 ${twDate(row.deadline)} 營業結束前至門市取貨（限購 1 桶），逾期視同放棄。\n` +
    `※ 品牌無法指定（大成／美食家），依當次到貨品牌出貨\n` +
    `取貨時請出示取貨碼，或打開登記頁的 QR Code。\n` +
    `👉 ${LIFF_URL}\n` +
    `\n📍 台北市大同區迪化街一段175號\n🈺 週一至週五 08:00–18:00｜週六 08:30–14:00`;
  return pushText(row.user_id, text, row.id);
}

// ── 客人 ──────────────────────────────────────────
async function me(userId: string): Promise<Record<string, unknown>> {
  const { data: rows } = await db.from("oil_queue").select("*").eq("user_id", userId)
    .order("id", { ascending: false }).limit(1);
  const row = rows?.[0];
  if (!row) return { row: null };
  const out: Record<string, unknown> = {
    row: {
      id: row.id, name: row.name, phone: row.phone, product: row.product, status: row.status,
      created_at: row.created_at,
    },
  };
  const r = out.row as Record<string, unknown>;
  if (row.status === "排隊中") r.position = await position(row);
  if (row.status === "已通知") {
    r.code = row.code;
    r.deadline_text = twDate(row.deadline);
  }
  if (row.status === "已取貨" && row.redeemed_at) {
    const next = new Date(new Date(row.redeemed_at).getTime() + COOLDOWN_DAYS * 86400000);
    r.redeemed_text = twDate(row.redeemed_at);
    if (next > new Date()) r.next_text = twDate(next);
  }
  return out;
}

async function register(userId: string, lineName: string, b: Record<string, any>) {
  const name = String(b.name ?? "").trim().slice(0, 30);
  const phone = String(b.phone ?? "").replace(/[^0-9]/g, "");
  const product = String(b.product ?? "");
  if (!name) throw new UserError("請填寫姓名或店名");
  if (phone.length < 8 || phone.length > 10) throw new UserError("請填寫正確的電話號碼");
  if (!PRODUCTS.includes(product)) throw new UserError("請選擇沙拉油或耐炸油");

  const { data: last } = await db.from("oil_queue").select("status,redeemed_at").eq("user_id", userId)
    .order("id", { ascending: false }).limit(1);
  const prev = last?.[0];
  if (prev && (prev.status === "排隊中" || prev.status === "已通知")) {
    throw new UserError("您已經登記過了，每人只能登記一種油品");
  }
  if (prev?.status === "已取貨" && prev.redeemed_at) {
    const next = new Date(new Date(prev.redeemed_at).getTime() + COOLDOWN_DAYS * 86400000);
    if (next > new Date()) throw new UserError(`取貨後 ${COOLDOWN_DAYS} 天內不能再登記，${twDate(next)} 起可以重新登記`);
  }
  const { error } = await db.from("oil_queue").insert({ user_id: userId, display_name: lineName, name, phone, product });
  if (error) {
    if (error.code === "23505") throw new UserError("您已經登記過了，每人只能登記一種油品");
    throw error;
  }
  const out = await me(userId);
  // 送不出去（沒加好友／封鎖）就讓登記頁提醒他，不然到貨通知也收不到
  out.confirm_sent = await pushConfirm({ ...(out.row as Record<string, unknown>), user_id: userId });
  return out;
}

async function cancel(userId: string) {
  await db.from("oil_queue").update({ status: "已取消", note: "客人自行取消" })
    .eq("user_id", userId).in("status", ["排隊中", "已通知"]);
  return me(userId);
}

// ── 門市後台 ──────────────────────────────────────
async function adminList() {
  const { data: active } = await db.from("oil_queue").select("*")
    .in("status", ["排隊中", "已通知"]).order("id");
  const { data: done } = await db.from("oil_queue").select("*")
    .in("status", ["已取貨", "已逾期", "已取消"]).order("id", { ascending: false }).limit(100);
  return { active: active ?? [], done: done ?? [] };
}

async function adminRelease(b: Record<string, any>) {
  const product = String(b.product ?? "");
  const qty = Math.floor(Number(b.qty));
  if (!PRODUCTS.includes(product)) throw new UserError("請選擇品項");
  if (!(qty >= 1 && qty <= 200)) throw new UserError("請輸入放出桶數（1～200）");
  const { data: rows } = await db.from("oil_queue").select("*")
    .eq("product", product).eq("status", "排隊中").order("id").limit(qty);
  const results = [];
  for (const row of rows ?? []) {
    const now = new Date();
    let updated = null;
    for (let i = 0; i < 5 && !updated; i++) { // 取貨碼撞到就換一組
      const { data, error } = await db.from("oil_queue").update({
        status: "已通知", code: newCode(), notified_at: now.toISOString(), deadline: deadlineFrom(now).toISOString(),
      }).eq("id", row.id).eq("status", "排隊中").select().maybeSingle();
      if (error && error.code !== "23505") throw error;
      if (!error) {
        updated = data;
        if (!data) break; // 同時被別人處理掉了
      }
    }
    if (!updated) continue;
    const ok = await pushNotice(updated);
    await db.from("oil_queue").update({ push_ok: ok }).eq("id", updated.id);
    results.push({ ...updated, push_ok: ok });
  }
  return { released: results, short: qty - results.length };
}

async function adminLookup(b: Record<string, any>) {
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!code) throw new UserError("請輸入取貨碼");
  const { data } = await db.from("oil_queue").select("*").eq("code", code).maybeSingle();
  if (!data) throw new UserError(`查無取貨碼 ${code}`);
  return { row: { ...data, deadline_text: data.deadline ? twDate(data.deadline) : "" } };
}

async function adminRedeem(b: Record<string, any>) {
  const code = String(b.code ?? "").trim().toUpperCase();
  const { data } = await db.from("oil_queue").update({ status: "已取貨", redeemed_at: new Date().toISOString() })
    .eq("code", code).eq("status", "已通知").gte("deadline", new Date().toISOString()).select().maybeSingle();
  if (!data) {
    const { row } = await adminLookup(b);
    throw new UserError(`無法兌換：這組取貨碼目前是「${row.status}」`);
  }
  return { row: data };
}

async function adminCancel(b: Record<string, any>) {
  const { data } = await db.from("oil_queue").update({ status: "已取消", note: String(b.note ?? "門市取消") })
    .eq("id", Number(b.id)).in("status", ["排隊中", "已通知"]).select().maybeSingle();
  if (!data) throw new UserError("這筆登記已經不是排隊中或已通知，無法取消");
  return { row: data };
}

async function adminResend(b: Record<string, any>) {
  const { data: row } = await db.from("oil_queue").select("*").eq("id", Number(b.id)).maybeSingle();
  if (!row || row.status !== "已通知") throw new UserError("只有「已通知」的登記可以重發通知");
  const ok = await pushNotice(row);
  await db.from("oil_queue").update({ push_ok: ok }).eq("id", row.id);
  return { push_ok: ok };
}

// ── 入口 ──────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);
  try {
    const b = await req.json();
    const action = String(b.action ?? "");
    if (action.startsWith("admin_")) {
      const role = ADMIN_PW && b.password === ADMIN_PW ? "admin" : STAFF_PW && b.password === STAFF_PW ? "staff" : "";
      if (!role) return json({ error: "密碼錯誤" }, 401);
      if (role === "staff" && !STAFF_ACTIONS.includes(action)) return json({ error: "員工帳號沒有這個權限，請用管理者密碼" }, 403);
      await expireOverdue();
      switch (action) {
        case "admin_login": return json({ ok: true, role });
        case "admin_list": return json(await adminList());
        case "admin_release": return json(await adminRelease(b));
        case "admin_lookup": return json(await adminLookup(b));
        case "admin_redeem": return json(await adminRedeem(b));
        case "admin_cancel": return json(await adminCancel(b));
        case "admin_resend": return json(await adminResend(b));
      }
      return json({ error: "未知的動作" }, 400);
    }
    // 清逾期跟向 LINE 驗證身分互不相干，同時跑省一趟等待
    const [user] = await Promise.all([lineUser(String(b.idToken ?? "")), expireOverdue()]);
    switch (action) {
      case "me": return json(await me(user.userId));
      case "register": return json(await register(user.userId, user.name, b));
      case "cancel": return json(await cancel(user.userId));
    }
    return json({ error: "未知的動作" }, 400);
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "系統錯誤，請稍後再試" }, 500);
  }
});
