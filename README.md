# 油品排隊登記

門市貼 QR Code → 客人用 LINE 掃描登記（沙拉油／耐炸油擇一、每人 1 桶）→ 看自己排第幾位 → 到貨時門市一鍵用官方 LINE 通知並附取貨碼 → 客人憑取貨碼到門市兌換。

跟 POS（line-oa-shipping）是不同專案；資料放在同一個 Supabase 專案，表名 `oil_` 開頭，LINE 推播共用叫貨帳號的 token。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 客人登記頁（LINE LIFF，在 LINE 裡打開） |
| `admin.html` | 門市後台：取貨兌換（可用手機相機掃 QR）、到貨通知、登記名單 |
| `poster.html` | 門市 A4 海報（QR Code） |
| `config.js` | LIFF ID、API 網址（公開，不放密碼） |
| `supabase/schema.sql` | 資料表 `oil_queue` |
| `supabase/functions/oil-queue/index.ts` | API（Edge Function） |

網頁放 GitHub Pages：`https://cacore.github.io/oil-queue/`（後台 `admin.html`、海報 `poster.html`）。

## 規則

- 每人（LINE 帳號）同時只能有一筆有效登記，沙拉油／耐炸油擇一，1 桶
- 到貨後依登記順序通知，**通知當天不算、往後 2 個營業日（週日不算）內取貨**，逾期自動作廢，可重新登記（排最後）
- 取貨後 10 天內不能再登記
- 只限門市自取

狀態：排隊中 → 已通知（有取貨碼）→ 已取貨；或 已逾期／已取消。

## 設定步驟

1. **LINE Login 頻道 + LIFF**（LINE Developers，跟叫貨帳號同一個 Provider）
   - Linked LINE Official Account：叫貨帳號
   - LIFF：Size Full、Endpoint `https://cacore.github.io/oil-queue/`、Scopes `profile` `openid`、Add friend option `On (Aggressive)`
   - 頻道狀態改 Published
2. **Supabase SQL Editor** 執行 `supabase/schema.sql`
3. **Supabase Edge Functions** 新增 `oil-queue`，貼上 `index.ts`，**關閉 Verify JWT**
4. **Edge Function Secrets** 新增：
   - `OIL_LIFF_ID`：LIFF ID
   - `OIL_ADMIN_PASSWORD`：管理者密碼（全部功能）
   - `OIL_STAFF_PASSWORD`：員工密碼（只能取貨兌換、看名單）
   - （`LINE_CHANNEL_ACCESS_TOKEN` 已存在，line-webhook 共用）
5. `config.js` 填 LIFF ID，push 到 GitHub
