-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:41:29 UTC on kuklfnapbkmacvwxktbh.

-- Audit follow-through (winner-prize family): a failed winner credit is
-- repaired within a minute WHEN the engine managed to file its alert (the
-- auto-repair tick redrives per incident). If the engine dies before
-- alerting, the only net was the DAILY 02:40 payout sweep - up to a 24h
-- wait to be made whole. The sweep took 600s before the 15:51 ANALYZE fix
-- and 14.8s after, so an hourly narrow sweep (7-day lookback, small budget)
-- is affordable and shrinks the worst case from 24 hours to one.
SELECT cron.schedule('ca-payout-sweep-hourly', '52 * * * *',
  $$select case
      when pg_try_advisory_lock(hashtext('tourney-payout-sweep-hourly'))
        then (select set_config('statement_timeout','120s',true) is not null
                 and (public.fn_tournament_payout_sweep(7, false, 5000) ->> 'ok') = 'true')::text
      else 'skipped: previous run still in progress'
    end;$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES ('cron', 'ca-payout-sweep-hourly', NULL, 'audit follow-through: hourly winner-payout sweep (no-alert gap)', true)
ON CONFLICT DO NOTHING;;
