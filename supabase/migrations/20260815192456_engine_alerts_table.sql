-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815192456 "engine_alerts_table"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7ab28d723f1cb1237b70d5b8d2964aea of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Durable record of every alert Alertmanager delivers.
--
-- 2026-08-15: the monitoring stack had 27 alert rules referencing metrics that
-- do not exist and routed everything to a null-receiver, so ten tables frozen
-- for 18 minutes produced no signal anywhere. This table is the audit trail
-- that survives regardless of whether email/SMS delivery succeeds — "did we
-- know?" must always be answerable.
create table if not exists public.engine_alerts (
  id            bigserial primary key,
  fingerprint   text        not null,
  alertname     text        not null,
  severity      text        not null default 'unknown',
  component     text,
  status        text        not null default 'firing',
  summary       text,
  description   text,
  labels        jsonb       not null default '{}'::jsonb,
  starts_at     timestamptz,
  ends_at       timestamptz,
  received_at   timestamptz not null default now(),
  notified_via  text[]      not null default '{}'
);

create index if not exists engine_alerts_received_idx on public.engine_alerts (received_at desc);
create index if not exists engine_alerts_active_idx  on public.engine_alerts (alertname, status, received_at desc);
create index if not exists engine_alerts_fingerprint_idx on public.engine_alerts (fingerprint, received_at desc);

alter table public.engine_alerts enable row level security;

-- Service role only. No anon/authenticated policy: this is operational data
-- written by the Alertmanager webhook and read by admin tooling.
revoke all on public.engine_alerts from anon, authenticated;
grant all on public.engine_alerts to service_role;
grant usage, select on sequence public.engine_alerts_id_seq to service_role;

comment on table public.engine_alerts is
  'Alertmanager webhook deliveries. Durable "did we know?" audit trail for engine freezes and infra alerts. Written by /api/alerts/engine.';
