-- =============================================================
-- ケアタイム勤怠 : Supabase スキーマ
-- Supabase の SQL Editor にこのファイルの中身を全部貼り付けて「Run」してください。
-- 新しいプロジェクトで1回だけ実行します。
-- =============================================================

-- ---------- テーブル ----------
create table public.staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  wage        integer not null default 0 check (wage >= 0),        -- 時給（円）
  transport   integer not null default 0 check (transport >= 0),   -- 交通費（円/日）
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text not null default '',
  role          text not null default 'staff' check (role in ('staff','admin')),
  staff_id      uuid references public.staff(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table public.shifts (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  work_date   date not null,
  start_time  time not null,
  end_time    time not null,          -- start より早ければ翌日終了（夜勤）
  memo        text not null default '',
  created_at  timestamptz not null default now()
);

create table public.records (
  id               uuid primary key default gen_random_uuid(),
  staff_id         uuid not null references public.staff(id) on delete cascade,
  user_id          uuid references auth.users(id) on delete set null,
  work_date        date not null,
  in_at            timestamptz not null,
  out_at           timestamptz,
  break_min        integer not null default 0 check (break_min between 0 and 600),
  edited_by_admin  boolean not null default false,
  created_at       timestamptz not null default now(),
  check (out_at is null or out_at >= in_at)
);

create table public.requests (
  id             uuid primary key default gen_random_uuid(),
  staff_id       uuid not null references public.staff(id) on delete cascade,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  record_id      uuid references public.records(id) on delete set null,   -- null = 打刻漏れの申請
  work_date      date not null,
  in_time        time not null,
  out_time       time not null,
  break_min      integer not null default 0 check (break_min between 0 and 600),
  reason         text not null,
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_comment  text,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz
);

create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid references public.staff(id) on delete set null,
  user_id     uuid default auth.uid() references auth.users(id) on delete set null,
  resident    text not null,
  cats        text[] not null default '{}',
  body        text not null,
  created_at  timestamptz not null default now()
);

create table public.settings (
  id          integer primary key default 1 check (id = 1),
  residents   text[] not null default '{}',
  night_rate  numeric not null default 25,   -- 深夜割増 %
  ot_rate     numeric not null default 25,   -- 残業割増 %
  ot_hours    numeric not null default 8     -- 1日の所定時間
);
insert into public.settings (id) values (1);

-- ---------- インデックス ----------
create index on public.profiles (staff_id);
create index on public.shifts (staff_id, work_date);
create index on public.shifts (work_date);
create index on public.records (staff_id, work_date);
create index on public.records (work_date);
create index on public.records (user_id);
create unique index records_one_open_per_staff on public.records (staff_id) where out_at is null;
create index on public.requests (staff_id);
create index on public.requests (user_id);
create index on public.requests (record_id);
create index on public.requests (status);
create index on public.notes (staff_id);
create index on public.notes (user_id);
create index on public.notes (created_at desc);

-- ---------- ヘルパー関数 ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin') $$;

create or replace function public.my_staff_id()
returns uuid language sql stable security definer set search_path = ''
as $$ select staff_id from public.profiles where id = (select auth.uid()) $$;

-- 新規登録したアカウントのプロフィールを自動作成。
-- 最初に登録した1人だけ自動で管理者になります（オーナーが最初に登録してください）。
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    case when exists (select 1 from public.profiles where role = 'admin') then 'staff' else 'admin' end
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- スタッフ名の一覧（時給は含まない）。紐付け済みのスタッフと管理者だけが読める。
create or replace function public.staff_directory()
returns table (id uuid, name text) language sql stable security definer set search_path = ''
as $$
  select s.id, s.name from public.staff s
  where public.is_admin() or public.my_staff_id() is not null
  order by s.created_at
$$;

-- 出勤（時刻はサーバーの現在時刻。スマホの時計をずらしても不正できない）
create or replace function public.clock_in()
returns public.records language plpgsql security definer set search_path = ''
as $$
declare
  sid uuid := public.my_staff_id();
  r public.records;
begin
  if sid is null then raise exception 'アカウントがまだスタッフに紐付いていません'; end if;
  if exists (select 1 from public.records where staff_id = sid and out_at is null) then
    raise exception 'すでに出勤中です';
  end if;
  insert into public.records (staff_id, user_id, work_date, in_at)
  values (sid, auth.uid(), (now() at time zone 'Asia/Tokyo')::date, now())
  returning * into r;
  return r;
end $$;

-- 退勤
create or replace function public.clock_out(p_break integer)
returns public.records language plpgsql security definer set search_path = ''
as $$
declare
  sid uuid := public.my_staff_id();
  r public.records;
begin
  if sid is null then raise exception 'アカウントがまだスタッフに紐付いていません'; end if;
  update public.records
     set out_at = now(), break_min = greatest(0, least(coalesce(p_break, 0), 600))
   where id = (select id from public.records where staff_id = sid and out_at is null order by in_at desc limit 1)
  returning * into r;
  if r.id is null then raise exception '出勤中の記録がありません'; end if;
  return r;
end $$;

-- 修正依頼を承認して勤務記録に反映（管理者のみ）
create or replace function public.approve_request(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  q public.requests;
  v_in timestamptz;
  v_out timestamptz;
begin
  if not public.is_admin() then raise exception '管理者だけが承認できます'; end if;
  select * into q from public.requests where id = p_id for update;
  if not found or q.status <> 'pending' then raise exception 'この依頼はすでに対応済みです'; end if;
  v_in  := (q.work_date + q.in_time)  at time zone 'Asia/Tokyo';
  v_out := (q.work_date + q.out_time) at time zone 'Asia/Tokyo';
  if v_out <= v_in then v_out := v_out + interval '1 day'; end if;
  if q.record_id is not null and exists (select 1 from public.records where id = q.record_id) then
    update public.records
       set work_date = q.work_date, in_at = v_in, out_at = v_out, break_min = q.break_min, edited_by_admin = true
     where id = q.record_id;
  else
    insert into public.records (staff_id, user_id, work_date, in_at, out_at, break_min, edited_by_admin)
    values (q.staff_id, q.user_id, q.work_date, v_in, v_out, q.break_min, true);
  end if;
  update public.requests set status = 'approved', decided_at = now() where id = p_id;
end $$;

-- ---------- 権限 ----------
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.is_admin(), public.my_staff_id(), public.staff_directory(),
  public.clock_in(), public.clock_out(integer), public.approve_request(uuid) to authenticated;

-- ---------- 行レベルセキュリティ (RLS) ----------
alter table public.staff    enable row level security;
alter table public.profiles enable row level security;
alter table public.shifts   enable row level security;
alter table public.records  enable row level security;
alter table public.requests enable row level security;
alter table public.notes    enable row level security;
alter table public.settings enable row level security;

-- staff: 管理者は全部。スタッフは自分の行だけ（他人の時給は見えない）
create policy staff_select on public.staff for select to authenticated
  using ((select public.is_admin()) or id = (select public.my_staff_id()));
create policy staff_admin_insert on public.staff for insert to authenticated with check ((select public.is_admin()));
create policy staff_admin_update on public.staff for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy staff_admin_delete on public.staff for delete to authenticated using ((select public.is_admin()));

-- profiles: 自分の行は読める。変更は管理者だけ（自分で管理者にはなれない）
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy profiles_admin_update on public.profiles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- shifts: 自分のシフトだけ読める。作成は管理者
create policy shifts_select on public.shifts for select to authenticated
  using ((select public.is_admin()) or staff_id = (select public.my_staff_id()));
create policy shifts_admin_insert on public.shifts for insert to authenticated with check ((select public.is_admin()));
create policy shifts_admin_update on public.shifts for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy shifts_admin_delete on public.shifts for delete to authenticated using ((select public.is_admin()));

-- records: 自分の勤務記録だけ読める。打刻は clock_in / clock_out 関数経由のみ。直接の編集は管理者
create policy records_select on public.records for select to authenticated
  using ((select public.is_admin()) or staff_id = (select public.my_staff_id()));
create policy records_admin_insert on public.records for insert to authenticated with check ((select public.is_admin()));
create policy records_admin_update on public.records for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy records_admin_delete on public.records for delete to authenticated using ((select public.is_admin()));

-- requests: スタッフは自分の依頼を出せて読める。承認・却下は管理者
create policy requests_select on public.requests for select to authenticated
  using ((select public.is_admin()) or user_id = (select auth.uid()));
create policy requests_insert on public.requests for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and staff_id = (select public.my_staff_id())
    and status = 'pending' and admin_comment is null and decided_at is null
  );
create policy requests_admin_update on public.requests for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy requests_admin_delete on public.requests for delete to authenticated using ((select public.is_admin()));

-- notes (ケア記録): 紐付け済みスタッフ全員で共有（申し送り）。削除は本人か管理者
create policy notes_select on public.notes for select to authenticated
  using ((select public.is_admin()) or (select public.my_staff_id()) is not null);
create policy notes_insert on public.notes for insert to authenticated
  with check (user_id = (select auth.uid()) and staff_id = (select public.my_staff_id()));
create policy notes_delete on public.notes for delete to authenticated
  using ((select public.is_admin()) or user_id = (select auth.uid()));

-- settings: 紐付け済みスタッフは読める（利用者さん名の候補）。変更は管理者
create policy settings_select on public.settings for select to authenticated
  using ((select public.is_admin()) or (select public.my_staff_id()) is not null);
create policy settings_admin_update on public.settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- =============================================================
-- 追加：訪問ごとの打刻（訪問先・同行・情報共有事項）
-- =============================================================
alter table public.records
  add column visit text not null default '',
  add column accompany boolean not null default false,
  add column in_memo text not null default '',
  add column out_memo text not null default '';
alter table public.requests
  add column visit text not null default '',
  add column accompany boolean not null default false;

drop function public.clock_in();
drop function public.clock_out(integer);

create function public.clock_in(p_visit text, p_accompany boolean default false, p_memo text default '')
returns public.records language plpgsql security definer set search_path = ''
as $$
declare
  sid uuid := public.my_staff_id();
  v text := trim(coalesce(p_visit, ''));
  m text := trim(coalesce(p_memo, ''));
  r public.records;
begin
  if sid is null then raise exception 'アカウントがまだスタッフに紐付いていません'; end if;
  if v = '' then raise exception '訪問先を選んでください'; end if;
  if exists (select 1 from public.records where staff_id = sid and out_at is null) then
    raise exception 'すでに出勤中です。先に退勤してください';
  end if;
  insert into public.records (staff_id, user_id, work_date, in_at, visit, accompany, in_memo)
  values (sid, auth.uid(), (now() at time zone 'Asia/Tokyo')::date, now(), v, coalesce(p_accompany, false), m)
  returning * into r;
  if m <> '' then
    insert into public.notes (staff_id, user_id, resident, cats, body) values (sid, auth.uid(), v, array['申し送り'], m);
  end if;
  return r;
end $$;

create function public.clock_out(p_break integer default 0, p_memo text default '')
returns public.records language plpgsql security definer set search_path = ''
as $$
declare
  sid uuid := public.my_staff_id();
  m text := trim(coalesce(p_memo, ''));
  r public.records;
begin
  if sid is null then raise exception 'アカウントがまだスタッフに紐付いていません'; end if;
  update public.records
     set out_at = now(), break_min = greatest(0, least(coalesce(p_break, 0), 600)), out_memo = m
   where id = (select id from public.records where staff_id = sid and out_at is null order by in_at desc limit 1)
  returning * into r;
  if r.id is null then raise exception '出勤中の記録がありません'; end if;
  if m <> '' then
    insert into public.notes (staff_id, user_id, resident, cats, body) values (sid, auth.uid(), r.visit, array['申し送り'], m);
  end if;
  return r;
end $$;

create or replace function public.approve_request(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  q public.requests;
  v_in timestamptz;
  v_out timestamptz;
begin
  if not public.is_admin() then raise exception '管理者だけが承認できます'; end if;
  select * into q from public.requests where id = p_id for update;
  if not found or q.status <> 'pending' then raise exception 'この依頼はすでに対応済みです'; end if;
  v_in  := (q.work_date + q.in_time)  at time zone 'Asia/Tokyo';
  v_out := (q.work_date + q.out_time) at time zone 'Asia/Tokyo';
  if v_out <= v_in then v_out := v_out + interval '1 day'; end if;
  if q.record_id is not null and exists (select 1 from public.records where id = q.record_id) then
    update public.records
       set work_date = q.work_date, in_at = v_in, out_at = v_out, break_min = q.break_min, edited_by_admin = true,
           visit = case when q.visit <> '' then q.visit else visit end, accompany = q.accompany
     where id = q.record_id;
  else
    insert into public.records (staff_id, user_id, work_date, in_at, out_at, break_min, edited_by_admin, visit, accompany)
    values (q.staff_id, q.user_id, q.work_date, v_in, v_out, q.break_min, true, q.visit, q.accompany);
  end if;
  update public.requests set status = 'approved', decided_at = now() where id = p_id;
end $$;

revoke execute on function public.clock_in(text, boolean, text), public.clock_out(integer, text) from public, anon;
grant execute on function public.clock_in(text, boolean, text), public.clock_out(integer, text) to authenticated;
