-- 油品排隊登記：在 Supabase SQL Editor 執行一次
-- 只給 Edge Function（service role）存取，RLS 開啟且不開任何 policy

create table if not exists oil_queue (
  id           bigserial primary key,               -- 登記順序（越小越前面）
  user_id      text not null,                        -- LINE userId（叫貨帳號同 Provider）
  display_name text,                                 -- LINE 顯示名稱
  name         text not null,                        -- 客人填的姓名／店名
  phone        text not null,
  product      text not null check (product in ('沙拉油', '耐炸油')),
  status       text not null default '排隊中'
               check (status in ('排隊中', '已通知', '已取貨', '已逾期', '已取消')),
  code         text unique,                          -- 取貨碼（通知時產生）
  notified_at  timestamptz,
  deadline     timestamptz,                          -- 取貨期限（通知後 2 個營業日，週日不算）
  push_ok      boolean,                              -- LINE 通知有沒有送出去
  redeemed_at  timestamptz,
  note         text,
  created_at   timestamptz not null default now()
);

-- 一個 LINE 帳號同時只能有一筆有效登記（排隊中或已通知），沙拉油／耐炸油只能擇一
create unique index if not exists oil_queue_one_active
  on oil_queue (user_id) where status in ('排隊中', '已通知');

create index if not exists oil_queue_product_status on oil_queue (product, status, id);

alter table oil_queue enable row level security;
