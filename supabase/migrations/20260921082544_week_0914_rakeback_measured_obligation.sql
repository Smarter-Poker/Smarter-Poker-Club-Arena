-- Week of 2026-09-14: record the MEASURED rakeback obligation, and retract the
-- claim that it could not be derived.
--
-- accounting_deferred_obligations holds the two rows Dan acts on when he
-- authorises the one-off payment for the weeks the settlement floor skips (his
-- decision of 2026-09-20, recorded in union_settlement_floor.reason). For the
-- week of 2026-09-14 those rows carried 26,542.66 and stated:
--
--   "THE PAYABLE IS NOT DERIVABLE: accounting_agreement_history holds no
--    observation before 2026-09-14 12:09:27Z, so no per-player rate observed at
--    earning time exists for this week."
--
-- That is measurably wrong, and it understated the debt by 111,760.77.
--
-- 1. The 12:09:27Z boundary bounds only the first 5h06m of the week. Measured
--    from rake_attributions, 17,048.42 of the week basis of 615,842.54 (2.77%)
--    was earned before it. For the other 97.23% the terms in force at earning
--    time ARE observed, and they resolve for every single row: 0 of 995,408
--    rows failed to resolve a membership or an agent.
--
-- 2. The reconstruction is validated against the platform's own recorded
--    contracts. accounting_payable_earning_sources holds 705,112 cash rows for
--    this week (440,835.71 of rake) whose contract was captured by
--    fn_accounting_earning_contract AT EARNING TIME. Resolving membership and
--    agent terms out of accounting_agreement_history by observation interval and
--    applying the rate rule of fn_calculate_cash_rakeback_periods reproduces
--    them:
--      membership history_id mismatches .... 0
--      tier-2 and tier-3 amount mismatches . 0
--      rake_credit mismatches .............. 0
--      effective rate differences .......... 0 rows
--      rakeback reconstructed 97,570.32 vs recorded 97,570.32, error 0.00
--    2,753 rows (0.39%) resolve a different tier-1 agent ROW identity, which is
--    the case fn_accounting_agent_terms_at resolves by identity rather than by
--    (club, user). The effective rate is identical on every one of them, so no
--    money turns on it.
--
-- 3. 26,542.66 was never the debt. It is the sum of 866 pending
--    rakeback_periods rows written by the legacy daily path, whose cache
--    (rakeback_daily_user) last refreshed 2026-09-17 07:29Z and then stopped.
--    Those rows carry 173,311.84 of a 615,842.54 basis, 28.1% of the week.
--    That stall already has its root fix in 20260921064151.
--
-- WHAT IS MEASURED
--
-- rake_attributions is the complete source for this week: 355,189 of 355,192
-- cash rake records attribute exactly, 0.86 across 3 records is uncredited, and
-- there are no ghost twins. (The week of 2026-09-07 is NOT like this - its
-- attribution covers 8.8% - so that week keeps its legacy figure.)
--
--   club scope   Deep Stack Society       rake 238,816.96  rakeback  44,931.08
--   union scope  Midway (JAQK + SHARK)    rake 377,025.58  rakeback  93,372.35
--                                         -----------------------------------
--                                         rake 615,842.54  rakeback 138,303.43
--
--   strictly observed (earned at or after 12:09:27Z) ......... 134,439.33
--   the 5h06m head, priced at the earliest observed terms ....   3,864.10
--
-- THE HEAD SLICE IS AN INFERENCE, NOT A READING, AND IT IS 2.79% OF THE TOTAL.
-- accounting_agreement_history opens with a baseline snapshot of live state at
-- 12:09:27Z, and fn_accounting_terms_at refuses any earlier instant. The first
-- recorded CHANGE to any entity is 2026-09-16 08:35:47Z, 44 hours later, so
-- terms were demonstrably stable for a long stretch after the snapshot - but
-- nothing observed the 5h06m before it. The band 134,439.33 to 138,303.43 is
-- exactly that uncertainty. pending_amount records the upper bound: the missing
-- observation is our defect, and CLAUDE.md 10.9 does not let a player carry the
-- cost of our defect.
--
-- HORSES: all 674 players in this basis are horses. Under CLAUDE.md 10.5 they
-- earn and are paid exactly as humans, and none is filtered anywhere here.
--
-- THIS MIGRATION PAYS NOTHING AND SCHEDULES NOTHING. The floor of 2026-09-20 is
-- Dan's and is untouched. fn_calculate_cash_rakeback_periods still refuses this
-- week (historical_week_before_observed_source_cutover) and no certificate
-- exists, so nothing settles it automatically. This corrects the RECORD so the
-- one-off Dan authorises is for the right number. No cron, no sweep, no
-- backfill, no compensating write (CLAUDE.md 10.12).
--
-- THE 0.86: three cash rake records at 2026-09-14 11:47:00.101111Z (fc3c97d1
-- 0.13 on Deep Stack Society, 5c13db94 0.60 and f4ce701b 0.13 on the union
-- house club) have no rake_attributions rows. It is not a live defect: all
-- 1,747 cash records since this week closed are attributed with no gap. Two of
-- the three sit on the union house club, which is excluded from attribution
-- clubs by design. They stay uncredited and are recorded here; the rakeback
-- they would carry is about 0.19.
--
-- NOTE ON HOW THIS WAS APPLIED. It contains NO DDL - it is two UPDATEs on a
-- record table. The Supabase MCP's apply_migration runs a no-op ALTER TABLE on
-- supabase_migrations.schema_migrations before every call, and that DDL was
-- refused for 20 minutes by ca_break_window_refuses_ddl while an engine
-- Deployment Recovery cycled announced breaks. Rather than reload PostgREST
-- (~28 s) during a recovery, the body below was applied through execute_sql in
-- one transaction and its history row written with this reserved version. The
-- DDL the guard exists to prevent never ran. CLAUDE.md section 2, rule 8.
--
-- 10.9 test 4: the body re-derives all six figures and aborts unless every one
-- matches the probe. It was proved first in a rolled-back transaction (11.5).

-- THIS FILE CREATES NO PERSISTENT OBJECT, so it states its own proof, which is
-- the convention tests/a-merged-migration-must-be-live.law.test.ts binds from
-- 20260920 onward: two UPDATEs on a record table leave nothing in pg_proc or
-- pg_class for a reader to look up, so the reader is told exactly what to run.
-- Both expressions were run read-only against production on 2026-09-25 and
-- both returned true.
-- @live-proof: (SELECT count(*) = 2 FROM public.accounting_deferred_obligations WHERE period_start = '2026-09-14 07:00:00+00' AND period_end = '2026-09-21 07:00:00+00' AND reason LIKE '%RESTATED 2026-09-21 by migration 20260921082544%')
-- @live-proof: (SELECT round(sum(pending_amount),2) = 138303.43 FROM public.accounting_deferred_obligations WHERE period_start = '2026-09-14 07:00:00+00' AND period_end = '2026-09-21 07:00:00+00')
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='280s';

DO $mig$
DECLARE
  v_from timestamptz := ('2026-09-14'::timestamp AT TIME ZONE 'America/Los_Angeles');
  v_to   timestamptz := ('2026-09-21'::timestamp AT TIME ZONE 'America/Los_Angeles');
  v_h0   timestamptz := '2026-09-14 12:09:27.737434+00';
  v_club numeric; v_union numeric; v_basis numeric; v_unres bigint; v_paid bigint;
  v_club_obs numeric; v_union_obs numeric; v_reason text;
BEGIN
  SELECT count(*) INTO v_paid FROM public.rakeback_period_payouts pp
    JOIN public.rakeback_periods rp ON rp.id=pp.rakeback_period_id
   WHERE rp.period_start='2026-09-14' AND rp.period_end='2026-09-20';
  IF v_paid<>0 THEN RAISE EXCEPTION 'week_0914_already_has_payouts: %',v_paid; END IF;

  CREATE TEMP TABLE _seg ON COMMIT DROP AS
  WITH mt AS MATERIALIZED (
    SELECT split_part(entity_key,':',1)::uuid club_id, split_part(entity_key,':',2)::uuid player_id,
      CASE WHEN event_type='baseline' THEN '-infinity'::timestamptz ELSE observed_at END vf,
      COALESCE(LEAD(observed_at) OVER (PARTITION BY entity_key ORDER BY observed_at,id),'infinity') vt,
      COALESCE((after_terms->>'player_rakeback_pct')::numeric,0) deal,
      NULLIF(after_terms->>'agent_id','')::uuid agent_user
    FROM public.accounting_agreement_history WHERE entity_type='club_members'
  ), ai AS MATERIALIZED (
    SELECT (after_terms->>'club_id')::uuid club_id,(after_terms->>'user_id')::uuid user_id,
      CASE WHEN event_type='baseline' THEN '-infinity'::timestamptz ELSE observed_at END vf,
      COALESCE(LEAD(observed_at) OVER (PARTITION BY entity_key ORDER BY observed_at,id),'infinity') vt,
      COALESCE((after_terms->>'player_rakeback_rate')::numeric,0) prr,
      CASE WHEN (after_terms->>'commission_rate')::numeric>1 THEN (after_terms->>'commission_rate')::numeric/100
           ELSE (after_terms->>'commission_rate')::numeric END crate
    FROM public.accounting_agreement_history
     WHERE entity_type='agents' AND after_terms->>'status'='active')
  SELECT m.club_id, m.player_id,
         greatest(m.vf, COALESCE(a.vf,'-infinity')) vf,
         least(m.vt, COALESCE(a.vt,'infinity')) vt, m.deal,
         CASE WHEN m.agent_user IS NOT NULL THEN COALESCE(a.prr,0) ELSE 0 END offer,
         CASE WHEN m.agent_user IS NOT NULL THEN a.crate END cap
  FROM mt m
  LEFT JOIN ai a ON a.club_id=m.club_id AND a.user_id=m.agent_user AND a.vf<m.vt AND a.vt>m.vf;
  CREATE INDEX ON _seg(club_id,player_id);

  CREATE TEMP TABLE _att ON COMMIT DROP AS
  SELECT a.player_id,a.club_id,a.weighted_rake_credit amt,r.created_at ts,(r.created_at<v_h0) in_head
    FROM public.rake_attributions a
    JOIN public.rake_records r ON r.id=a.rake_record_id AND r.hand_id=a.hand_id
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND a.weighted_rake_credit>0;
  CREATE INDEX ON _att(club_id,player_id);

  CREATE TEMP TABLE _tot ON COMMIT DROP AS
  SELECT club_id,player_id,sum(amt) tr FROM _att GROUP BY 1,2;
  CREATE INDEX ON _tot(club_id,player_id);

  SELECT round(sum(amt),2),
         round(sum(amt*rate) FILTER (WHERE union_id IS NULL),2),
         round(sum(amt*rate) FILTER (WHERE union_id IS NOT NULL),2),
         round(COALESCE(sum(amt*rate) FILTER (WHERE union_id IS NULL AND NOT in_head),0),2),
         round(COALESCE(sum(amt*rate) FILTER (WHERE union_id IS NOT NULL AND NOT in_head),0),2),
         count(*) FILTER (WHERE rate IS NULL)
    INTO v_basis,v_club,v_union,v_club_obs,v_union_obs,v_unres
  FROM (
    SELECT t.amt,t.in_head,c.union_id,
      CASE WHEN s.cap>0 THEN least(b.base,greatest(s.cap-0.10,0)) ELSE b.base END rate
    FROM _att t
    JOIN _tot o ON o.club_id=t.club_id AND o.player_id=t.player_id
    JOIN public.clubs c ON c.id=t.club_id
    LEFT JOIN _seg s ON s.club_id=t.club_id AND s.player_id=t.player_id AND t.ts>=s.vf AND t.ts<s.vt
    CROSS JOIN LATERAL (SELECT CASE WHEN s.deal>0 THEN s.deal WHEN s.offer>0 THEN s.offer
        WHEN o.tr>=10000 THEN 0.30 WHEN o.tr>=2000 THEN 0.20 WHEN o.tr>=500 THEN 0.15
        WHEN o.tr>=100 THEN 0.10 ELSE 0.05 END base) b
  ) z;

  IF v_unres<>0 THEN RAISE EXCEPTION 'unresolved_terms_rows=%',v_unres; END IF;
  IF v_basis<>615842.54 THEN RAISE EXCEPTION 'basis moved: %',v_basis; END IF;
  IF v_club <>44931.08 THEN RAISE EXCEPTION 'club scope moved: %',v_club; END IF;
  IF v_union<>93372.35 THEN RAISE EXCEPTION 'union scope moved: %',v_union; END IF;
  IF v_club_obs <>43357.17 THEN RAISE EXCEPTION 'club observed moved: %',v_club_obs; END IF;
  IF v_union_obs<>91082.16 THEN RAISE EXCEPTION 'union observed moved: %',v_union_obs; END IF;

  v_reason := $r$RESTATED 2026-09-21 by migration 20260921082544 - see the migration header and docs/changelog/2026-09-21-week-0914-rakeback-was-derivable-after-all.md. Deep Stack Society, standalone: rake 238,816.96, rakeback 44,931.08 across 275 players, of which 43,357.17 is strictly observed and 1,573.91 is the 5h06m head priced at the earliest observed terms. Band 43,357.17 to 44,931.08; pending_amount carries the upper bound. Previous value 13,794.97 came from legacy rows covering 28.1% of the week. A RECORD, NOT A PAYMENT: the 2026-09-20 floor stands and nothing settles this automatically.$r$;
  UPDATE public.accounting_deferred_obligations
     SET pending_amount=v_club, observed_at=now(), reason=v_reason
  WHERE scope_kind='club' AND scope_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
    AND period_start='2026-09-14 07:00:00+00' AND period_end='2026-09-21 07:00:00+00';
  IF NOT FOUND THEN RAISE EXCEPTION 'club obligation row not found'; END IF;

  v_reason := $r$RESTATED 2026-09-21 by migration 20260921082544 - see the migration header and docs/changelog/2026-09-21-week-0914-rakeback-was-derivable-after-all.md. Midway Union (Club JAQK 173,961.36 and SHARK CLUB 203,064.22): rake 377,025.58, rakeback 93,372.35 across 369 players, of which 91,082.16 is strictly observed and 2,290.19 is the 5h06m head priced at the earliest observed terms. Band 91,082.16 to 93,372.35; pending_amount carries the upper bound. Previous value 12,747.69 came from legacy rows covering 28.1% of the week. A RECORD, NOT A PAYMENT: the 2026-09-20 floor stands and nothing settles this automatically.$r$;
  UPDATE public.accounting_deferred_obligations
     SET pending_amount=v_union, observed_at=now(), reason=v_reason
  WHERE scope_kind='union' AND scope_id='fade0000-0000-0000-0000-000000000001'
    AND period_start='2026-09-14 07:00:00+00' AND period_end='2026-09-21 07:00:00+00';
  IF NOT FOUND THEN RAISE EXCEPTION 'union obligation row not found'; END IF;

  UPDATE public.accounting_deferred_obligations
     SET reason=replace(reason,
       'As with the week of 2026-09-14, no per-player rate observed at earning time exists (accounting_agreement_history begins 2026-09-14 12:09:27Z), so the amount owed is Dan''s decision.',
       'No per-player rate observed at earning time exists for THIS week: accounting_agreement_history begins 2026-09-14 12:09:27Z, after this week had already ended, so every rate for it would be back-extrapolation. That is specific to this week and is NOT true of the week of 2026-09-14, whose obligation was measured and restated on 2026-09-21 (migration 20260921082544). Do not carry this sentence forward to that week.')
   WHERE period_start='2026-09-07 07:00:00+00' AND period_end='2026-09-14 07:00:00+00';

  RAISE NOTICE 'week 0914 restated: club % union % total %',v_club,v_union,v_club+v_union;
END $mig$;

COMMIT;
