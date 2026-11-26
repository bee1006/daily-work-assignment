-- Run in Supabase Dashboard > SQL Editor after creating the project.
-- V3.3 Normalized 9-Table Architecture with Microsoft Entra ID Admin Approval Gate, First-Login Password Change & RLS Enforcement
-- Admins: u971503@taipower.com.tw, bee1006@gmail.com
-- Assistant (pre-reserved): guest@taipower.local (login as "guest" / "123456")

-- ============================================================
-- 1. User profiles & roles (admin / inspector / assistant)
-- ============================================================
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'inspector' check (role in ('admin', 'inspector')),
  sub_role text not null default 'inspector' check (sub_role in ('admin', 'inspector', 'assistant')),
  staff_id text,
  staff_name text,
  approved boolean not null default false,
  must_change_password boolean not null default false,
  auth_provider text not null default 'email',
  display_name text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.user_profiles
  add column if not exists sub_role text not null default 'inspector'
  check (sub_role in ('admin', 'inspector', 'assistant'));

alter table public.user_profiles
  add column if not exists approved boolean not null default true,
  add column if not exists must_change_password boolean not null default false,
  add column if not exists auth_provider text not null default 'email',
  add column if not exists display_name text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id) on delete set null;

alter table public.user_profiles
  alter column approved set default false;

create index if not exists user_profiles_approved_idx on public.user_profiles (approved, updated_at desc);
create index if not exists user_profiles_email_lower_idx on public.user_profiles (lower(email));
create index if not exists user_profiles_approved_by_idx on public.user_profiles (approved_by);

alter table public.user_profiles enable row level security;

create table if not exists public.preapproved_users (
  email text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null default 'inspector' check (role in ('admin', 'inspector')),
  sub_role text not null default 'inspector' check (sub_role in ('admin', 'inspector', 'assistant')),
  staff_id text,
  staff_name text,
  note text not null default '',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by uuid references auth.users(id) on delete set null
);

alter table public.preapproved_users
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by uuid references auth.users(id) on delete set null;

create index if not exists preapproved_users_created_by_idx on public.preapproved_users (created_by);
create index if not exists preapproved_users_claimed_by_idx on public.preapproved_users (claimed_by);
alter table public.preapproved_users enable row level security;

drop policy if exists "Team reads user profiles" on public.user_profiles;
create policy "Team reads user profiles"
  on public.user_profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_approved()));

-- Helper functions (security definer + search_path='' prevents policy recursion on user_profiles)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(coalesce((select auth.jwt()) ->> 'email', '')) in ('u971503@taipower.com.tw', 'bee1006@gmail.com')
    or exists (
      select 1 from public.user_profiles
      where user_id = (select auth.uid())
        and approved = true
        and (role = 'admin' or sub_role = 'admin')
    );
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(coalesce((select auth.jwt()) ->> 'email', '')) in ('u971503@taipower.com.tw', 'bee1006@gmail.com', 'guest@taipower.local')
    or exists (
      select 1 from public.user_profiles
      where user_id = (select auth.uid())
        and approved = true
    );
$$;

revoke execute on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;

create or replace function public.is_assistant()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'guest@taipower.local'
    or exists (
      select 1 from public.user_profiles
      where user_id = (select auth.uid())
        and approved = true
        and (sub_role = 'assistant' or staff_id = '__assistant__')
    );
$$;

revoke execute on function public.is_assistant() from public, anon;
grant execute on function public.is_assistant() to authenticated;

create or replace function public.my_staff_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select staff_id from public.user_profiles
  where user_id = (select auth.uid())
    and approved = true;
$$;

revoke execute on function public.my_staff_id() from public, anon;
grant execute on function public.my_staff_id() to authenticated;

-- Atomic profile bootstrap & pre-approval claim RPC (new Microsoft users default to approved = false)
create or replace function public.sync_my_profile(
  p_display_name text default null,
  p_provider text default null
)
returns public.user_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_provider text;
  v_display_name text;
  v_is_admin boolean;
  v_is_guest boolean;
  v_existing public.user_profiles%rowtype;
  v_pre public.preapproved_users%rowtype;
  v_result public.user_profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select
    lower(btrim(coalesce(nullif((select auth.jwt()) ->> 'email', ''), u.email, ''))),
    coalesce(nullif(u.raw_app_meta_data ->> 'provider', ''), nullif(btrim(coalesce(p_provider, '')), ''), 'email'),
    nullif(left(btrim(coalesce(nullif(p_display_name, ''), u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), 100), '')
  into v_email, v_provider, v_display_name
  from auth.users u
  where u.id = v_uid;

  if coalesce(v_email, '') = '' then
    v_email := lower(btrim(coalesce((select auth.jwt()) ->> 'email', '')));
    v_provider := coalesce(nullif(btrim(coalesce(p_provider, '')), ''), 'email');
    v_display_name := nullif(left(btrim(coalesce(p_display_name, '')), 100), '');
  end if;

  v_is_admin := v_email in ('u971503@taipower.com.tw', 'bee1006@gmail.com');
  v_is_guest := (v_email = 'guest@taipower.local');

  select * into v_existing
  from public.user_profiles
  where user_id = v_uid;

  select * into v_pre
  from public.preapproved_users
  where email = v_email and claimed_at is null;

  if v_existing.user_id is null then
    if v_is_admin then
      insert into public.user_profiles (
        user_id, email, role, sub_role, approved, approved_at, auth_provider, display_name, updated_at
      ) values (
        v_uid, v_email, 'admin', 'admin', true, now(), v_provider, v_display_name, now()
      )
      returning * into v_result;
      if v_pre.email is not null then
        update public.preapproved_users set claimed_at = now(), claimed_by = v_uid where email = v_email;
      end if;
    elsif v_is_guest then
      insert into public.user_profiles (
        user_id, email, role, sub_role, staff_id, staff_name, approved, approved_at, auth_provider, display_name, updated_at
      ) values (
        v_uid, v_email, 'inspector', 'assistant', '__assistant__', '助理專用(guest)', true, now(), v_provider, v_display_name, now()
      )
      returning * into v_result;
      if v_pre.email is not null then
        update public.preapproved_users set claimed_at = now(), claimed_by = v_uid where email = v_email;
      end if;
    elsif v_pre.email is not null then
      insert into public.user_profiles (
        user_id, email, role, sub_role, staff_id, staff_name, approved, approved_at, approved_by, auth_provider, display_name, updated_at
      ) values (
        v_uid, v_email, v_pre.role, v_pre.sub_role, v_pre.staff_id, v_pre.staff_name, true, now(), v_pre.created_by, v_provider, v_display_name, now()
      )
      returning * into v_result;
      update public.preapproved_users set claimed_at = now(), claimed_by = v_uid where email = v_email;
    else
      insert into public.user_profiles (
        user_id, email, role, sub_role, staff_id, staff_name, approved, auth_provider, display_name, updated_at
      ) values (
        v_uid, v_email, 'inspector', 'inspector', null, null, false, v_provider, v_display_name, now()
      )
      returning * into v_result;
    end if;
  else
    if v_is_admin then
      update public.user_profiles
      set email = coalesce(nullif(v_email, ''), email),
          role = 'admin',
          sub_role = 'admin',
          approved = true,
          approved_at = coalesce(approved_at, now()),
          auth_provider = v_provider,
          display_name = coalesce(v_display_name, display_name),
          updated_at = now()
      where user_id = v_uid
      returning * into v_result;
      if v_pre.email is not null then
        update public.preapproved_users set claimed_at = now(), claimed_by = v_uid where email = v_email;
      end if;
    elsif v_is_guest then
      update public.user_profiles
      set email = coalesce(nullif(v_email, ''), email),
          sub_role = 'assistant',
          staff_id = '__assistant__',
          staff_name = coalesce(staff_name, '助理專用(guest)'),
          approved = true,
          approved_at = coalesce(approved_at, now()),
          auth_provider = v_provider,
          display_name = coalesce(v_display_name, display_name),
          updated_at = now()
      where user_id = v_uid
      returning * into v_result;
      if v_pre.email is not null then
        update public.preapproved_users set claimed_at = now(), claimed_by = v_uid where email = v_email;
      end if;
    elsif not v_existing.approved and v_pre.email is not null then
      update public.user_profiles
      set email = coalesce(nullif(v_email, ''), email),
          role = v_pre.role,
          sub_role = v_pre.sub_role,
          staff_id = coalesce(v_pre.staff_id, staff_id),
          staff_name = coalesce(v_pre.staff_name, staff_name),
          approved = true,
          approved_at = now(),
          approved_by = v_pre.created_by,
          auth_provider = v_provider,
          display_name = coalesce(v_display_name, display_name),
          updated_at = now()
      where user_id = v_uid
      returning * into v_result;
      update public.preapproved_users set claimed_at = now(), claimed_by = v_uid where email = v_email;
    else
      update public.user_profiles
      set email = coalesce(nullif(v_email, ''), email),
          auth_provider = v_provider,
          display_name = coalesce(v_display_name, display_name),
          updated_at = now()
      where user_id = v_uid
      returning * into v_result;
    end if;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.sync_my_profile(text, text) from public, anon;
grant execute on function public.sync_my_profile(text, text) to authenticated;

create or replace function public.complete_password_change()
returns public.user_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_result public.user_profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  update public.user_profiles
  set must_change_password = false,
      updated_at = now()
  where user_id = v_uid
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.complete_password_change() from public, anon;
grant execute on function public.complete_password_change() to authenticated;

create or replace function public.admin_reset_user_password(p_target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
begin
  if v_uid is null or not public.is_admin() then
    raise exception 'Only admins can reset passwords';
  end if;

  if p_target_user_id is null or p_target_user_id = v_uid then
    raise exception 'Invalid target user';
  end if;

  select lower(coalesce(email, '')) into v_email
  from auth.users
  where id = p_target_user_id;

  if coalesce(v_email, '') = '' then
    raise exception 'Target user not found';
  end if;

  if v_email in ('u971503@taipower.com.tw', 'bee1006@gmail.com') then
    raise exception 'Cannot reset built-in admin password here';
  end if;

  update auth.users
  set encrypted_password = extensions.crypt('123456', extensions.gen_salt('bf')),
      updated_at = now()
  where id = p_target_user_id;

  update public.user_profiles
  set must_change_password = true,
      updated_at = now()
  where user_id = p_target_user_id;

  return true;
end;
$$;

revoke execute on function public.admin_reset_user_password(uuid) from public, anon;
grant execute on function public.admin_reset_user_password(uuid) to authenticated;

-- Auto-confirm new accounts created by Admin or pre-seeded assistant
create schema if not exists private;

create or replace function private.auto_confirm_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function private.auto_confirm_auth_user() from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'on_auth_user_auto_confirm'
  ) then
    create trigger on_auth_user_auto_confirm
      before insert on auth.users
      for each row execute function private.auto_confirm_auth_user();
  end if;
end
$$;

drop policy if exists "Users insert own profile" on public.user_profiles;
create policy "Users insert own profile"
  on public.user_profiles for insert to authenticated
  with check (
    (select public.is_admin())
    or (
      (select auth.uid()) = user_id
      and role = 'inspector'
      and sub_role = 'inspector'
      and approved = false
    )
  );

drop policy if exists "Users update own profile or admin updates" on public.user_profiles;
create policy "Users update own profile or admin updates"
  on public.user_profiles for update to authenticated
  using (
    (select public.is_admin())
    or ((select auth.uid()) = user_id and (select public.is_approved()))
  )
  with check (
    (select public.is_admin())
    or (
      (select auth.uid()) = user_id
      and (select public.is_approved())
      and approved = true
      and role = 'inspector'
      and sub_role = 'inspector'
    )
  );

drop policy if exists "Admins delete user profiles" on public.user_profiles;
create policy "Admins delete user profiles"
  on public.user_profiles for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.user_profiles to authenticated;

drop policy if exists "Admins read preapproved users" on public.preapproved_users;
create policy "Admins read preapproved users"
  on public.preapproved_users for select to authenticated
  using ((select public.is_admin()));

drop policy if exists "Admins insert preapproved users" on public.preapproved_users;
create policy "Admins insert preapproved users"
  on public.preapproved_users for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "Admins update preapproved users" on public.preapproved_users;
create policy "Admins update preapproved users"
  on public.preapproved_users for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins delete preapproved users" on public.preapproved_users;
create policy "Admins delete preapproved users"
  on public.preapproved_users for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.preapproved_users to authenticated;

-- ============================================================
-- 2. Staff roster (一人一列；僅最高使用者增刪改)
-- ============================================================
create table if not exists public.staff_roster (
  id text primary key,
  name text not null,
  supervisor boolean not null default true,
  default_attending boolean not null default true,
  default_noncritical boolean not null default false,
  sort_order integer not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.staff_roster enable row level security;

drop policy if exists "Team reads staff roster" on public.staff_roster;
create policy "Team reads staff roster"
  on public.staff_roster for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "Admins insert staff roster" on public.staff_roster;
create policy "Admins insert staff roster"
  on public.staff_roster for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "Admins update staff roster" on public.staff_roster;
create policy "Admins update staff roster"
  on public.staff_roster for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins delete staff roster" on public.staff_roster;
create policy "Admins delete staff roster"
  on public.staff_roster for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.staff_roster to authenticated;

-- ============================================================
-- 3. Attendance records (日期 + 人員 一列；檢驗員僅能改本人，助理純觀看)
-- ============================================================
create table if not exists public.attendance_records (
  work_date date not null,
  staff_id text not null,
  status_type text not null default 'normal',
  attending boolean not null default true,
  noncritical boolean not null default false,
  note text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (work_date, staff_id)
);

create index if not exists attendance_records_staff_id_idx on public.attendance_records (staff_id);
create index if not exists attendance_records_updated_by_idx on public.attendance_records (updated_by);

alter table public.attendance_records enable row level security;

drop policy if exists "Team reads attendance records" on public.attendance_records;
create policy "Team reads attendance records"
  on public.attendance_records for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "Admin or self inserts attendance record" on public.attendance_records;
create policy "Admin or self inserts attendance record"
  on public.attendance_records for insert to authenticated
  with check (
    (select public.is_admin())
    or ((select public.is_approved()) and not (select public.is_assistant()) and staff_id = (select public.my_staff_id()))
  );

drop policy if exists "Admin or self updates attendance record" on public.attendance_records;
create policy "Admin or self updates attendance record"
  on public.attendance_records for update to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and not (select public.is_assistant()) and staff_id = (select public.my_staff_id()))
  )
  with check (
    (select public.is_admin())
    or ((select public.is_approved()) and not (select public.is_assistant()) and staff_id = (select public.my_staff_id()))
  );

drop policy if exists "Admins delete attendance record" on public.attendance_records;
create policy "Admins delete attendance record"
  on public.attendance_records for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.attendance_records to authenticated;

-- ============================================================
-- 4. Calendar day notes (每日特別任務 — 一日一列；僅最高使用者增刪改)
-- ============================================================
create table if not exists public.calendar_day_notes (
  work_date date primary key,
  note text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists calendar_day_notes_updated_by_idx on public.calendar_day_notes (updated_by);

alter table public.calendar_day_notes enable row level security;

drop policy if exists "Team reads calendar day notes" on public.calendar_day_notes;
create policy "Team reads calendar day notes"
  on public.calendar_day_notes for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "Admins insert calendar day notes" on public.calendar_day_notes;
create policy "Admins insert calendar day notes"
  on public.calendar_day_notes for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "Admins update calendar day notes" on public.calendar_day_notes;
create policy "Admins update calendar day notes"
  on public.calendar_day_notes for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins delete calendar day notes" on public.calendar_day_notes;
create policy "Admins delete calendar day notes"
  on public.calendar_day_notes for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.calendar_day_notes to authenticated;

-- ============================================================
-- 5. Raw work uploads (助理專用上游表 — 僅助理與管理員可寫入，全員可讀)
-- ============================================================
create table if not exists public.raw_work_uploads (
  work_date date primary key,
  filename text not null default '',
  coordinates jsonb not null default '{}'::jsonb,
  jobs jsonb not null default '[]'::jsonb,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists raw_work_uploads_uploaded_by_idx on public.raw_work_uploads (uploaded_by);

alter table public.raw_work_uploads enable row level security;

drop policy if exists "Team reads raw work uploads" on public.raw_work_uploads;
create policy "Team reads raw work uploads"
  on public.raw_work_uploads for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "Admin or assistant inserts raw work uploads" on public.raw_work_uploads;
create policy "Admin or assistant inserts raw work uploads"
  on public.raw_work_uploads for insert to authenticated
  with check ((select public.is_admin()) or (select public.is_assistant()));

drop policy if exists "Admin or assistant updates raw work uploads" on public.raw_work_uploads;
create policy "Admin or assistant updates raw work uploads"
  on public.raw_work_uploads for update to authenticated
  using ((select public.is_admin()) or (select public.is_assistant()))
  with check ((select public.is_admin()) or (select public.is_assistant()));

drop policy if exists "Admins delete raw work uploads" on public.raw_work_uploads;
create policy "Admins delete raw work uploads"
  on public.raw_work_uploads for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.raw_work_uploads to authenticated;

-- ============================================================
-- 6. Daily dispatches (主管確認後的正式派工表 — 僅最高使用者寫入，全員可讀)
-- ============================================================
create table if not exists public.daily_dispatches (
  work_date date primary key,
  first_staff text not null,
  filename text not null default '',
  weather text not null default '晴',
  proximity_km numeric not null default 10,
  coordinates jsonb not null default '{}'::jsonb,
  jobs jsonb not null default '[]'::jsonb,
  assignments jsonb not null default '{}'::jsonb,
  manual_assignments jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists daily_dispatches_updated_by_idx on public.daily_dispatches (updated_by);

alter table public.daily_dispatches enable row level security;

drop policy if exists "Team reads daily dispatches" on public.daily_dispatches;
create policy "Team reads daily dispatches"
  on public.daily_dispatches for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "Admins insert daily dispatches" on public.daily_dispatches;
drop policy if exists "Team inserts daily dispatches" on public.daily_dispatches;
create policy "Team inserts daily dispatches"
  on public.daily_dispatches for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "Admins update daily dispatches" on public.daily_dispatches;
drop policy if exists "Team updates daily dispatches" on public.daily_dispatches;
create policy "Team updates daily dispatches"
  on public.daily_dispatches for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins delete daily dispatches" on public.daily_dispatches;
create policy "Admins delete daily dispatches"
  on public.daily_dispatches for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.daily_dispatches to authenticated;

-- ============================================================
-- 7. Daily work notes (每日工作備註 — 僅最高使用者與檢驗員寫入，助理純觀看)
-- ============================================================
create table if not exists public.daily_work_notes (
  work_date date not null,
  team_key text not null,
  note text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (work_date, team_key)
);

create index if not exists daily_work_notes_updated_by_idx on public.daily_work_notes (updated_by);

alter table public.daily_work_notes enable row level security;

drop policy if exists "Team reads daily work notes" on public.daily_work_notes;
create policy "Team reads daily work notes"
  on public.daily_work_notes for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "Team inserts daily work notes" on public.daily_work_notes;
create policy "Team inserts daily work notes"
  on public.daily_work_notes for insert to authenticated
  with check ((select public.is_admin()) or ((select public.is_approved()) and not (select public.is_assistant())));

drop policy if exists "Team updates daily work notes" on public.daily_work_notes;
create policy "Team updates daily work notes"
  on public.daily_work_notes for update to authenticated
  using ((select public.is_admin()) or ((select public.is_approved()) and not (select public.is_assistant())))
  with check ((select public.is_admin()) or ((select public.is_approved()) and not (select public.is_assistant())));

drop policy if exists "Team deletes daily work notes" on public.daily_work_notes;
create policy "Team deletes daily work notes"
  on public.daily_work_notes for delete to authenticated
  using ((select public.is_admin()) or ((select public.is_approved()) and not (select public.is_assistant())));

grant select, insert, update, delete on public.daily_work_notes to authenticated;

-- ============================================================
-- 8. Acceptance records (檢驗員驗收紀錄 — 管理員與檢驗員可管理全部；助理可新增及刪除／修改自己建立的紀錄)
-- ============================================================
create table if not exists public.acceptance_records (
  id uuid primary key default gen_random_uuid(),
  work_date date not null,
  zone text not null,
  batch text not null default '',
  staff_name text not null default '',
  note text not null default '',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists acceptance_records_work_date_idx on public.acceptance_records (work_date, created_at);
create index if not exists acceptance_records_created_by_idx on public.acceptance_records (created_by);

alter table public.acceptance_records enable row level security;

drop policy if exists "Team reads acceptance records" on public.acceptance_records;
create policy "Team reads acceptance records"
  on public.acceptance_records for select to authenticated
  using ((select public.is_approved()));

drop policy if exists "Team inserts acceptance records" on public.acceptance_records;
create policy "Team inserts acceptance records"
  on public.acceptance_records for insert to authenticated
  with check ((select public.is_approved()) and (created_by is null or created_by = (select auth.uid())));

drop policy if exists "Team updates acceptance records" on public.acceptance_records;
create policy "Team updates acceptance records"
  on public.acceptance_records for update to authenticated
  using ((select public.is_admin()) or ((select public.is_approved()) and (not (select public.is_assistant()) or created_by = (select auth.uid()))))
  with check ((select public.is_admin()) or ((select public.is_approved()) and (not (select public.is_assistant()) or created_by = (select auth.uid()))));

drop policy if exists "Team deletes acceptance records" on public.acceptance_records;
create policy "Team deletes acceptance records"
  on public.acceptance_records for delete to authenticated
  using ((select public.is_admin()) or ((select public.is_approved()) and (not (select public.is_assistant()) or created_by = (select auth.uid()))));

grant select, insert, update, delete on public.acceptance_records to authenticated;
