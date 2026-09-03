-- ═════════════════════════════════════════════════════════════════════
-- Phase 5.2.0 — Sentry autofix dedup / rate-limit / audit table
-- ═════════════════════════════════════════════════════════════════════
-- Tracks every Sentry issue the autofix webhook handled, what the
-- corresponding Claude run produced, and the downstream PR outcome.
-- Used for:
--   1. Dedup — partial unique index prevents two open attempts per issue.
--   2. Rate-limit — hourly/daily counts by created_at.
--   3. Audit — full record of Claude confidence, tokens, PR URL, result.
-- ═════════════════════════════════════════════════════════════════════

create table if not exists public.autofix_attempts (
  id                    uuid primary key default gen_random_uuid(),
  repo                  text not null,
  sentry_issue_id       text not null,
  sentry_project_slug   text,
  short_id              text,
  fingerprint           text,
  title                 text,
  level                 text,
  status                text not null default 'queued'
    check (status in ('queued','running','pr_opened','merged','rejected','errored')),
  run_id                text,
  fix_branch            text,
  fix_pr_url            text,
  fix_pr_number         int,
  changed_files         text[],
  claude_confidence     text,
  claude_tokens_in      int,
  claude_tokens_out     int,
  error_message         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists autofix_attempts_created_at_idx
  on public.autofix_attempts (created_at desc);

create index if not exists autofix_attempts_issue_idx
  on public.autofix_attempts (sentry_issue_id, created_at desc);

-- Dedup: only one OPEN attempt per Sentry issue at a time. merged,
-- rejected, errored don't count against this — those are resolved states.
create unique index if not exists autofix_attempts_one_open_per_issue
  on public.autofix_attempts (sentry_issue_id)
  where status in ('queued','running','pr_opened');

-- Keep updated_at fresh automatically.
create or replace function public.autofix_attempts_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists autofix_attempts_touch on public.autofix_attempts;
create trigger autofix_attempts_touch
before update on public.autofix_attempts
for each row execute function public.autofix_attempts_touch_updated_at();

-- RLS: no anon access; service-role only.
alter table public.autofix_attempts enable row level security;

drop policy if exists autofix_attempts_service_role_all on public.autofix_attempts;
create policy autofix_attempts_service_role_all
  on public.autofix_attempts
  for all
  to service_role
  using (true)
  with check (true);

-- Ops-facing view for Grafana / dashboards.
create or replace view public.autofix_attempts_summary as
  select
    date_trunc('hour', created_at)      as hour,
    sentry_project_slug                 as project,
    status,
    count(*)                            as attempts,
    sum(claude_tokens_in)               as tokens_in,
    sum(claude_tokens_out)              as tokens_out
  from public.autofix_attempts
  group by 1, 2, 3
  order by 1 desc, 2, 3;

comment on table  public.autofix_attempts is 'Phase 5.2.0 — Sentry→Claude autofix loop audit + dedup';
comment on column public.autofix_attempts.status is 'queued|running|pr_opened|merged|rejected|errored';
comment on index  public.autofix_attempts_one_open_per_issue is 'Dedup: only one in-flight attempt per Sentry issue';
