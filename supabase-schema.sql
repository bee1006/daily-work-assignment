-- Run in Supabase Dashboard > SQL Editor after creating the project.
-- V2.3 Normalized 7-Table Architecture with Row-Level RBAC
-- Admins: u971503@taipower.com.tw, bee1006@gmail.com

-- ============================================================
-- 1. User profiles & roles
-- ============================================================
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'inspector' check (role in ('admin', 'inspector')),
  staff_id text,
  staff_name text,
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

drop policy if exists "Team reads user profiles" on public.user_profiles;
create policy "Team reads user profiles"
  on public.user_profiles for select to authenticated
  using (true);

-- Helper functions (security invoker avoids privileged definer exposure; user_profiles SELECT policy is open to authenticated)
create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select lower(coalesce((select auth.jwt()) ->> 'email', '')) in ('u971503@taipower.com.tw', 'bee1006@gmail.com')
    or exists (
      select 1 from public.user_profiles
      where user_id = (select auth.uid()) and role = 'admin'
    );
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.my_staff_id()
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select staff_id from public.user_profiles where user_id = (select auth.uid());
$$;

revoke execute on function public.my_staff_id() from public, anon;
grant execute on function public.my_staff_id() to authenticated;

drop policy if exists "Users insert own profile" on public.user_profiles;
create policy "Users insert own profile"
  on public.user_profiles for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      role = 'inspector'
      or lower(coalesce((select auth.jwt()) ->> 'email', '')) in ('u971503@taipower.com.tw', 'bee1006@gmail.com')
      or (select public.is_admin())
    )
  );

drop policy if exists "Users update own profile or admin updates" on public.user_profiles;
create policy "Users update own profile or admin updates"
  on public.user_profiles for update to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()))
  with check (
    (select public.is_admin())
    or (
      (select auth.uid()) = user_id
      and (
        role = 'inspector'
        or lower(coalesce((select auth.jwt()) ->> 'email', '')) in ('u971503@taipower.com.tw', 'bee1006@gmail.com')
      )
    )
  );

grant select, insert, update on public.user_profiles to authenticated;

-- ============================================================
-- 2. Staff roster (一人一列)
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
  using (true);

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
-- 3. Attendance records (日期 + 人員 一列；一般同仁僅能修改本人)
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
  using (true);

drop policy if exists "Admin or self inserts attendance record" on public.attendance_records;
create policy "Admin or self inserts attendance record"
  on public.attendance_records for insert to authenticated
  with check ((select public.is_admin()) or staff_id = (select public.my_staff_id()));

drop policy if exists "Admin or self updates attendance record" on public.attendance_records;
create policy "Admin or self updates attendance record"
  on public.attendance_records for update to authenticated
  using ((select public.is_admin()) or staff_id = (select public.my_staff_id()))
  with check ((select public.is_admin()) or staff_id = (select public.my_staff_id()));

drop policy if exists "Admins delete attendance record" on public.attendance_records;
create policy "Admins delete attendance record"
  on public.attendance_records for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.attendance_records to authenticated;

-- ============================================================
-- 4. Calendar day notes (每日特別任務 — 一日一列)
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
  using (true);

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
-- 5. Daily dispatches (每日派工主表 — 一日一列；僅最高使用者寫入)
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
  using (true);

drop policy if exists "Admins insert daily dispatches" on public.daily_dispatches;
create policy "Admins insert daily dispatches"
  on public.daily_dispatches for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists "Admins update daily dispatches" on public.daily_dispatches;
create policy "Admins update daily dispatches"
  on public.daily_dispatches for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "Admins delete daily dispatches" on public.daily_dispatches;
create policy "Admins delete daily dispatches"
  on public.daily_dispatches for delete to authenticated
  using ((select public.is_admin()));

grant select, insert, update, delete on public.daily_dispatches to authenticated;

-- ============================================================
-- 6. Daily work notes (每日工作備註 — 日期 + 工班 一列)
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
  using (true);

drop policy if exists "Team inserts daily work notes" on public.daily_work_notes;
create policy "Team inserts daily work notes"
  on public.daily_work_notes for insert to authenticated
  with check (true);

drop policy if exists "Team updates daily work notes" on public.daily_work_notes;
create policy "Team updates daily work notes"
  on public.daily_work_notes for update to authenticated
  using (true)
  with check (true);

drop policy if exists "Team deletes daily work notes" on public.daily_work_notes;
create policy "Team deletes daily work notes"
  on public.daily_work_notes for delete to authenticated
  using (true);

grant select, insert, update, delete on public.daily_work_notes to authenticated;

-- ============================================================
-- 7. Acceptance records (檢驗員驗收紀錄 — 一筆驗收一列)
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
  using (true);

drop policy if exists "Team inserts acceptance records" on public.acceptance_records;
create policy "Team inserts acceptance records"
  on public.acceptance_records for insert to authenticated
  with check (true);

drop policy if exists "Team updates acceptance records" on public.acceptance_records;
create policy "Team updates acceptance records"
  on public.acceptance_records for update to authenticated
  using (true)
  with check (true);

drop policy if exists "Team deletes acceptance records" on public.acceptance_records;
create policy "Team deletes acceptance records"
  on public.acceptance_records for delete to authenticated
  using (true);

grant select, insert, update, delete on public.acceptance_records to authenticated;
