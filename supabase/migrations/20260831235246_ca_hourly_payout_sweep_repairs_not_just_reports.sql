-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:52:46 UTC on kuklfnapbkmacvwxktbh.

-- The hourly sweep ran with p_apply=false: it could SEE an unpaid winner but
-- not pay them (23:45 UTC proved it - two unpaid winners sat there while the
-- sweep looked on). The reconciler is idempotent, conservative (pays only the
-- documented payout structure, never more than expected minus already_paid),
-- and every credit it makes is a ledgered linked entry - exactly the
-- sanctioned correction path. The hourly pass now applies; the daily 02:40
-- wide pass stays detect-only as the independent second opinion.
SELECT cron.schedule('ca-payout-sweep-hourly', '52 * * * *',
$$select case
      when pg_try_advisory_lock(hashtext('tourney-payout-sweep-hourly'))
        then (select set_config('statement_timeout','120s',true) is not null
                 and (public.fn_tournament_payout_sweep(7, true, 5000) ->> 'ok') = 'true')::text
      else 'skipped: previous run still in progress'
    end;$$);;
