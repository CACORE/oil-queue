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

-- 到貨紀錄：後台每按一次「通知前幾位」記一筆（什麼時候、哪種油、放出幾桶、實際通知幾位）
create table if not exists oil_releases (
  id          bigserial primary key,
  product     text not null check (product in ('沙拉油', '耐炸油')),
  qty         int not null,            -- 這次放出幾桶（後台輸入的數字）
  notified    int not null,            -- 實際通知幾位（排隊人數不夠時會比 qty 少）
  push_failed int not null default 0,  -- LINE 沒送出、要打電話的人數
  note        text,
  reissue     boolean not null default false, -- 補放上批沒領走的油（不是新到貨，不算進近 4 週放出）
  created_at  timestamptz not null default now()
);
alter table oil_releases enable row level security;
alter table oil_releases add column if not exists reissue boolean not null default false;
