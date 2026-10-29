// 油品排隊登記設定（公開網頁，這裡不要放任何密碼或金鑰）
window.OIL = {
  LIFF_ID: "請填入LIFF_ID",   // LINE Developers → LINE Login 頻道 → LIFF 分頁
  API: "https://exooakgctfkgyixtuyoj.supabase.co/functions/v1/oil-queue",
};
window.OIL.LIFF_URL = "https://liff.line.me/" + window.OIL.LIFF_ID;

async function oilApi(body) {
  const r = await fetch(window.OIL.API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* 非 JSON 回應 */ }
  if (!r.ok) throw new Error(data.error || "連線失敗，請稍後再試");
  return data;
}
