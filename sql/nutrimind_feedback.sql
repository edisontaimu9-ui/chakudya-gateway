-- NutriMind feedback (thumbs up / down). Run once in the Supabase SQL editor.
-- The gateway inserts rows with the public anon key; nobody can read them except you
-- (dashboard / service role). A changed mind is a new row, so use the *_latest view for totals.

create table if not exists public.nutrimind_feedback (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  fid        text not null check (fid ~ '^[a-z0-9]{8,40}$'),
  rating     text not null check (rating in ('up', 'down', 'none')),
  reason     text not null default '' check (reason in ('', 'inaccurate', 'incomplete', 'unclear', 'other')),
  mode       text not null default 'both' check (mode in ('both', 'general', 'clinical')),
  question   text not null check (char_length(question) between 1 and 600),
  answer     text not null default '' check (char_length(answer) <= 4000)
);
create index if not exists nutrimind_feedback_fid_idx on public.nutrimind_feedback (fid, created_at desc);

alter table public.nutrimind_feedback enable row level security;
revoke all on public.nutrimind_feedback from anon, authenticated;
grant insert on public.nutrimind_feedback to anon;
drop policy if exists "anon can add feedback" on public.nutrimind_feedback;
create policy "anon can add feedback" on public.nutrimind_feedback for insert to anon with check (true);

-- Latest rating per answer (read it in the dashboard).
create or replace view public.nutrimind_feedback_latest with (security_invoker = true) as
  select distinct on (fid) * from public.nutrimind_feedback order by fid, created_at desc;
revoke all on public.nutrimind_feedback_latest from anon, authenticated;
