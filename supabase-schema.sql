-- Run in Supabase Dashboard > SQL Editor after creating the project.
-- Every record belongs to the signed-in user; anonymous requests see no data.
create table if not exists public.dispatch_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  work_date date not null,
  first_staff text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, work_date)
);

alter table public.dispatch_history enable row level security;

drop policy if exists "Users read own dispatch history" on public.dispatch_history;
create policy "Users read own dispatch history"
  on public.dispatch_history for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own dispatch history" on public.dispatch_history;
create policy "Users insert own dispatch history"
  on public.dispatch_history for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own dispatch history" on public.dispatch_history;
create policy "Users update own dispatch history"
  on public.dispatch_history for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.dispatch_history to authenticated;
