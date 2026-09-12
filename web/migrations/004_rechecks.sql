-- Scheduled re-checks: the piece that makes a bound channel a subscription.
--
-- `site_audits` keeps each finished audit's result so the next run can answer "what moved"
-- instead of re-reporting the same findings. The earlier schema deliberately stored no results
-- because nothing read them back — the recheck loop is the reader they were waiting for.

create table if not exists site_audits (
  id       uuid primary key default gen_random_uuid(),
  site_id  uuid not null references sites(id) on delete cascade,
  score    int,
  result   jsonb not null,
  ran_at   timestamptz not null default now()
);

create index if not exists idx_site_audits_site on site_audits(site_id, ran_at desc);

-- A bound channel is what makes a site worth re-auditing at all — the schedule exists to tell
-- someone when something moved. This flag is the off switch that does not require unbinding.
alter table sites add column if not exists recheck_enabled boolean not null default true;
