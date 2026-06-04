-- ============================================================
-- MUNDIAL 2026 — Supabase Schema
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────
create table if not exists users (
  id               uuid primary key default gen_random_uuid(),
  username         text unique not null,
  favorite_team    text not null,
  following_teams  text[] not null default '{}',
  total_points     integer default 0,
  created_at       timestamptz default now()
);

-- ─────────────────────────────────────────
-- MATCHES  (populated by sync function)
-- ─────────────────────────────────────────
create table if not exists matches (
  id                   text primary key,
  home_team            text not null,
  away_team            text not null,
  home_score           integer,
  away_score           integer,
  kickoff_utc          timestamptz not null,
  status               text default 'SCHEDULED',
  stage                text default 'GROUP',
  group_name           text,
  venue                text,
  broadcast_platforms  text[] default '{}',
  is_featured          boolean default false,
  match_of_the_day     text,
  updated_at           timestamptz default now()
);

-- index for common queries
create index if not exists matches_kickoff_idx on matches(kickoff_utc);
create index if not exists matches_status_idx  on matches(status);

-- Enable Realtime on matches
alter publication supabase_realtime add table matches;

-- ─────────────────────────────────────────
-- PREDICTIONS
-- ─────────────────────────────────────────
create table if not exists predictions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references users(id) on delete cascade,
  match_id          text references matches(id) on delete cascade,
  predicted_home    integer not null,
  predicted_away    integer not null,
  man_of_match      text,
  points_awarded    integer,
  created_at        timestamptz default now(),
  unique(user_id, match_id)
);

create index if not exists predictions_user_idx  on predictions(user_id);
create index if not exists predictions_match_idx on predictions(match_id);

-- ─────────────────────────────────────────
-- STANDINGS
-- ─────────────────────────────────────────
create table if not exists standings (
  id          uuid primary key default gen_random_uuid(),
  group_name  text not null,
  team        text not null,
  played      integer default 0,
  won         integer default 0,
  drawn       integer default 0,
  lost        integer default 0,
  gf          integer default 0,
  ga          integer default 0,
  gd          integer default 0,
  points      integer default 0,
  updated_at  timestamptz default now(),
  unique(group_name, team)
);

create index if not exists standings_group_idx on standings(group_name);

-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────

-- Users: anyone can read; only own row to insert/update
alter table users enable row level security;

create policy "users_select_all" on users for select using (true);
create policy "users_insert_own" on users for insert with check (true);
create policy "users_update_own" on users for update using (true);

-- Matches: public read; only service role writes
alter table matches enable row level security;
create policy "matches_select_all" on matches for select using (true);

-- Predictions: read all for leaderboard; insert/update own
alter table predictions enable row level security;
create policy "predictions_select_all" on predictions for select using (true);
create policy "predictions_insert_own" on predictions for insert with check (true);
create policy "predictions_update_own" on predictions for update using (true);

-- Standings: public read
alter table standings enable row level security;
create policy "standings_select_all" on standings for select using (true);

-- ─────────────────────────────────────────
-- SEED — Demo matches so the app looks alive
-- (remove once real API data flows in)
-- ─────────────────────────────────────────
insert into matches (id, home_team, away_team, kickoff_utc, status, stage, group_name, venue, broadcast_platforms, is_featured)
values
  ('WC2026-001', 'MX', 'EC', now() + interval '2 days', 'SCHEDULED', 'GROUP', 'A', 'SoFi Stadium, Los Angeles', '{"ESPN","DSports"}', true),
  ('WC2026-002', 'US', 'CA', now() + interval '2 days 3 hours', 'SCHEDULED', 'GROUP', 'B', 'MetLife Stadium, New York', '{"Teleamazonas"}', false),
  ('WC2026-003', 'BR', 'AR', now() + interval '3 days', 'SCHEDULED', 'GROUP', 'C', 'AT&T Stadium, Dallas', '{"ESPN"}', true),
  ('WC2026-004', 'FR', 'DE', now() + interval '3 days 3 hours', 'SCHEDULED', 'GROUP', 'D', 'Levi''s Stadium, San Jose', '{"DSports"}', false),
  ('WC2026-005', 'ES', 'PT', now() + interval '4 days', 'SCHEDULED', 'GROUP', 'E', 'Arrowhead Stadium, Kansas City', '{"ESPN"}', false),
  ('WC2026-006', 'CO', 'UY', now() + interval '4 days 3 hours', 'SCHEDULED', 'GROUP', 'F', 'Estadio Azteca, Mexico City', '{"DSports","Canal Uno"}', false),
  ('WC2026-007', 'EC', 'PE', now() + interval '5 days', 'SCHEDULED', 'GROUP', 'A', 'NRG Stadium, Houston', '{"ESPN","Teleamazonas"}', true),
  ('WC2026-008', 'NG', 'MA', now() + interval '5 days 3 hours', 'SCHEDULED', 'GROUP', 'G', 'BC Place, Vancouver', '{"DSports"}', false)
on conflict (id) do nothing;

-- Seed standings
insert into standings (group_name, team, played, won, drawn, lost, gf, ga, gd, points) values
  ('A', 'MX', 0,0,0,0,0,0,0,0),
  ('A', 'EC', 0,0,0,0,0,0,0,0),
  ('A', 'PE', 0,0,0,0,0,0,0,0),
  ('A', 'SN', 0,0,0,0,0,0,0,0),
  ('B', 'US', 0,0,0,0,0,0,0,0),
  ('B', 'CA', 0,0,0,0,0,0,0,0),
  ('B', 'CM', 0,0,0,0,0,0,0,0),
  ('B', 'MA', 0,0,0,0,0,0,0,0),
  ('C', 'BR', 0,0,0,0,0,0,0,0),
  ('C', 'AR', 0,0,0,0,0,0,0,0),
  ('C', 'UY', 0,0,0,0,0,0,0,0),
  ('C', 'PY', 0,0,0,0,0,0,0,0),
  ('D', 'FR', 0,0,0,0,0,0,0,0),
  ('D', 'DE', 0,0,0,0,0,0,0,0),
  ('D', 'NL', 0,0,0,0,0,0,0,0),
  ('D', 'BE', 0,0,0,0,0,0,0,0),
  ('E', 'ES', 0,0,0,0,0,0,0,0),
  ('E', 'PT', 0,0,0,0,0,0,0,0),
  ('E', 'HR', 0,0,0,0,0,0,0,0),
  ('E', 'TR', 0,0,0,0,0,0,0,0),
  ('F', 'CO', 0,0,0,0,0,0,0,0),
  ('F', 'UY', 0,0,0,0,0,0,0,0),
  ('F', 'VE', 0,0,0,0,0,0,0,0),
  ('F', 'BO', 0,0,0,0,0,0,0,0),
  ('G', 'NG', 0,0,0,0,0,0,0,0),
  ('G', 'GH', 0,0,0,0,0,0,0,0),
  ('G', 'CI', 0,0,0,0,0,0,0,0),
  ('G', 'SN', 0,0,0,0,0,0,0,0),
  ('H', 'JP', 0,0,0,0,0,0,0,0),
  ('H', 'KR', 0,0,0,0,0,0,0,0),
  ('H', 'IR', 0,0,0,0,0,0,0,0),
  ('H', 'AU', 0,0,0,0,0,0,0,0)
on conflict (group_name, team) do nothing;
