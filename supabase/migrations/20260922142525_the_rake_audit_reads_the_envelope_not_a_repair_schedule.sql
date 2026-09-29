-- 20260922142525_the_rake_audit_reads_the_envelope_not_a_repair_schedule
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 14:25:25 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- rake-bbj-invariant-audit-hourly runs fn_rake_bbj_audit(2), which alarms on
-- fn_rake_bbj_invariants. Two of its money checks took their grace period
-- from a REPAIR JOB'S SCHEDULE instead of from the writer they judge:
--
--   I5_drop_not_banked_to_pool  read cron.job_run_details for the last
--                               successful run of ca-bbj-repair-unbanked-15m;
--   I7_raked_hand_never_banked  read it for rake-repair-unbanked-hourly.
--
-- A job that is not in cron.job answers NULL, the fallback was
-- now() - 2 hours, and the audit passes p_hours = 2, so the window became
-- [now() - 2h, now() - 2h): empty. ca-bbj-repair-unbanked-15m is already
-- retired, so I5 has read zero by construction ever since. Measured
-- 2026-09-22 14:04 UTC: I5 grace_source 'fallback', grace_until exactly two
-- hours before the call. Unscheduling rake-repair-unbanked-hourly would have
-- blinded I7 the same way, and I7 is the alarm BAND-AIDS-REGISTER TIER 1 #5
-- names as the criterion for retiring that job.
--
-- The writer no longer needs a healer's grace. Since 20260909215641 (applied
-- 2026-09-09 21:56 UTC; it dropped the legacy nine- and eleven-argument
-- doors) the only accepted-hand door, fn_ca_commit_hand_settlement, refuses a
-- hand whose rake is not carried by its post-commit envelope
-- (post_commit_fee_mismatch), in the same transaction as the hand row. The
-- envelope is banked by fn_ca_process_hand_post_commit_obligations in one
-- transaction, or it stays pending. Measured on production 2026-09-22 over
-- the last 7 days:
--
--   - 349,214 cash rake records from atomic_distribute_rake whose hand still
--     exists: 4 banked more than one minute after the hand, 0 more than five
--     minutes after, worst 1m40s;
--   - 0 raked cash club hands without a rake record;
--   - fn_rake_repair_unbanked: 0 recoveries. Its last two runs (2026-09-10
--     03:32, 5 hands; 2026-09-14 11:47, 3 hands) came after the door above,
--     so every one of those hands already had an envelope. Each rake record
--     they wrote has player_contributions NULL, which the envelope never
--     sends, so the repair took the first claim, and under
--     atomic_distribute_rake's first-claim rule the envelope's own call could
--     no longer attribute that rake to anyone.
--
-- WHAT THIS CHANGES
--
-- fn_rake_bbj_invariants is replaced whole. The scope and I1, I2, I3, I4, I6
-- and the I8 counters are byte-identical to the live body; the verify block
-- below cuts each of them out of the body this replaces and refuses unless
-- it is found verbatim in the new one.
--
--   - No scheduler lookup. I5 and I7 use the function's own v_grace, five
--     minutes, which is always inside the window.
--   - I7 counts a raked cash hand past the grace with no rake record AND no
--     pending envelope: nothing durable owes it, a genuine loss.
--   - I9_rake_owed_by_a_pending_envelope (new) counts an envelope that still
--     owes rake or a BBJ drop five minutes after its hand committed. Late,
--     not lost. It reads the pending partial index and has no lower time
--     bound, so a stuck envelope never ages out of view. It is not in
--     fn_rake_bbj_audit's money set, so it raises a warning, not a critical.
--   - I8 becomes I8_rake_banked_late and says what it now measures.
--
-- fn_rake_bbj_audit: its resolution note no longer claims that a repair job
-- recovers unbanked hands (pg_temp.ca_patch, one string, asserted once).
--
-- Nothing here moves money, writes a money row, or schedules anything. No
-- job is unscheduled here: the coordinator retires them in one change.
--
-- @live-proof: (SELECT position('cron.' in p.prosrc) = 0 AND position('I9_rake_owed_by_a_pending_envelope' in p.prosrc) > 0 AND position('post_commit_completed_at IS NULL' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_invariants')
-- @live-proof: (SELECT position('recovered by fn_rake_repair_unbanked' in p.prosrc) = 0 AND position('banked by fn_ca_process_hand_post_commit_obligations' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_audit')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN
    RAISE EXCEPTION 'ca_patch: % has % overloads in public (expected exactly 1)', p_fn, v_procs;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- The body being replaced, kept for the byte-for-byte proof below.
CREATE TEMP TABLE _ca_rake_audit_before ON COMMIT DROP AS
SELECT pg_get_functiondef(p.oid) AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_invariants';

-- 1. The audit. Replaced whole; see the header for what changed and the
--    verify block for the proof that nothing else did.
CREATE OR REPLACE FUNCTION public.fn_rake_bbj_invariants(p_hours integer DEFAULT 2)
 RETURNS TABLE(check_name text, violations bigint, detail jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 2), 1));
  -- Rule checks: settlement is not instant, but nothing heals a broken rule.
  v_grace timestamptz := now() - interval '5 minutes';
  /* THE GRACE BELONGS TO THE WRITER, NOT TO A REPAIR SCHEDULE (2026-09-22).
     I5 and I7 used to ask the job scheduler when a repair job last ran. A
     retired job answered NULL, the fallback was now() - 2 hours, and with
     p_hours = 2 that window is empty, so I5 read zero by construction. The
     rake and the BBJ drop of an accepted hand are owed by its post-commit
     envelope, committed with the hand, and banked in one transaction by
     fn_ca_process_hand_post_commit_obligations. Five minutes is that
     writer's own bound: a hand still owed after it is I9, a hand owed by
     nothing is I7. */
  v_min_dealt integer;
  v_inelig text[];
BEGIN
  SELECT r.bbj_min_players_dealt, r.bbj_ineligible_variants INTO v_min_dealt, v_inelig
    FROM public.ca_rake_rules r WHERE r.id = 1;

  RETURN QUERY
  WITH scope AS (
    SELECT r.hand_id, r.rake_amount, COALESCE(r.bbj_contribution, 0) AS bbj,
           r.pot_size, r.num_players, r.rake_method, r.player_contributions,
           r.created_at, hh.created_at AS hand_at,
           t.id AS tid, t.small_blind, t.big_blind, t.club_id,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(array_length(hh.community_cards, 1), 0) AS board
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id
      LEFT JOIN hand_history hh ON hh.id = r.hand_id
     WHERE r.source = 'atomic_distribute_rake'
       AND r.created_at >= v_since AND r.created_at < v_grace
       AND t.tournament_id IS NULL AND r.is_tournament IS NOT TRUE
  )
  SELECT 'I1_drop_under_3_dealt'::text, count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players)) FILTER (WHERE true), '[]'::jsonb)
    FROM (SELECT hand_id, num_players FROM scope
           WHERE bbj > 0 AND num_players IS NOT NULL AND num_players < v_min_dealt LIMIT 20) x
  UNION ALL
  SELECT 'I2_drop_on_ineligible_variant', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'variant', variant)), '[]'::jsonb)
    FROM (SELECT hand_id, variant FROM scope
           WHERE bbj > 0 AND variant = ANY (v_inelig) LIMIT 20) x
  UNION ALL
  SELECT 'I3_deductions_exceed_pot', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'pot', pot_size, 'take', take)), '[]'::jsonb)
    FROM (SELECT hand_id, pot_size, rake_amount + bbj AS take FROM scope
           WHERE pot_size IS NOT NULL AND pot_size > 0
             AND rake_amount + bbj > pot_size + 0.001 LIMIT 20) x
  UNION ALL
  SELECT 'I4_eligible_flop_no_drop', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'n', num_players, 'board', board, 'expected', expected)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.num_players, s.board,
                 public.fn_effective_bbj_drop(s.big_blind, s.num_players, s.board >= 3, s.club_id,
                                              s.tid, s.variant, s.small_blind, s.pot_size, s.rake_amount) AS expected
            FROM scope s
           WHERE s.bbj = 0 AND s.board >= 3
             AND public.fn_effective_bbj_drop(s.big_blind, s.num_players, s.board >= 3, s.club_id,
                                              s.tid, s.variant, s.small_blind, s.pot_size, s.rake_amount) > 0
           LIMIT 20) x
  UNION ALL
  SELECT 'I5_drop_not_banked_to_pool', count(*)::bigint,
         jsonb_build_object('grace_until', v_grace, 'grace_source', 'writer',
                            'owner', 'fn_ca_process_hand_post_commit_obligations',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'bbj', bbj)), '[]'::jsonb))
    FROM (SELECT s.hand_id, s.bbj FROM scope s
           WHERE s.bbj > 0 AND s.hand_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM bbj_contributions b
                              WHERE b.hand_id = s.hand_id
                                AND abs(b.amount - s.bbj) <= 0.01) LIMIT 20) x
  UNION ALL
  SELECT 'I6_ledger_not_reconciled', count(*)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'rake', rake_amount, 'alloc', alloc)), '[]'::jsonb)
    FROM (SELECT s.hand_id, s.rake_amount,
                 (SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                    FROM rake_attributions ra WHERE ra.hand_id = s.hand_id) AS alloc
            FROM scope s
           WHERE s.rake_method = 'WEIGHTED_CONTRIBUTED' AND s.rake_amount > 0
             AND s.hand_id IS NOT NULL AND s.player_contributions IS NOT NULL
             AND round((SELECT COALESCE(SUM(ra.weighted_rake_credit), 0)
                          FROM rake_attributions ra WHERE ra.hand_id = s.hand_id), 2)
                 <> round(s.rake_amount, 2) LIMIT 20) x
  UNION ALL
  SELECT 'I7_raked_hand_never_banked', count(*)::bigint,
         jsonb_build_object('grace_until', v_grace, 'grace_source', 'writer',
                            'owner', 'fn_ca_process_hand_post_commit_obligations',
                            'means', 'a raked cash hand older than five minutes with no rake record and no pending post-commit envelope owing it. Nothing durable will bank it, so this is a genuine loss. The accepted-hand door commits the rake obligation with the hand and fn_ca_process_hand_post_commit_obligations banks it in one transaction, so this reads zero unless a writer broke.',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', id, 'rake', rake_amount)), '[]'::jsonb))
    FROM (SELECT hh.id, hh.rake_amount
            FROM hand_history hh
            JOIN tables t ON t.id = hh.table_id
           WHERE hh.tournament_id IS NULL AND t.tournament_id IS NULL
             AND t.club_id IS NOT NULL AND hh.rake_amount > 0
             AND hh.created_at >= v_since
             AND hh.created_at < v_grace
             AND NOT EXISTS (SELECT 1 FROM rake_records rr WHERE rr.hand_id = hh.id)
             AND NOT EXISTS (SELECT 1 FROM rake_records rr2
                              WHERE rr2.table_id = hh.table_id
                                AND rr2.created_at BETWEEN hh.created_at - interval '2 hours'
                                                       AND hh.created_at + interval '12 hours'
                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
             AND NOT EXISTS (SELECT 1 FROM hand_atomic_commits c
                              WHERE c.hand_id = hh.id
                                AND c.post_commit_payload IS NOT NULL
                                AND c.post_commit_completed_at IS NULL)
           LIMIT 20) x
  UNION ALL
  SELECT 'I9_rake_owed_by_a_pending_envelope', count(*)::bigint,
         jsonb_build_object('grace_until', v_grace,
                            'owner', 'fn_ca_process_hand_post_commit_obligations',
                            'means', 'an accepted hand whose post-commit envelope still owes its rake or BBJ drop more than five minutes after the hand committed. Late, not lost: the envelope is the record, and only fn_ca_process_hand_post_commit_obligations may bank it, with the contributions that attribute it. Nothing else banks it, so a hand stays here until the engine or its successor drains the envelope.',
                            'hands', COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'table', table_id,
                                               'hand_number', hand_number, 'committed_at', committed_at)), '[]'::jsonb))
    FROM (SELECT c.hand_id, c.table_id, c.hand_number, c.committed_at
            FROM hand_atomic_commits c
           WHERE c.post_commit_payload IS NOT NULL
             AND c.post_commit_completed_at IS NULL
             AND c.committed_at < v_grace
             AND (jsonb_typeof(c.post_commit_payload->'rake') = 'object'
                  OR jsonb_typeof(c.post_commit_payload->'bbj_contribution') = 'object')
           ORDER BY c.committed_at
           LIMIT 20) x
  UNION ALL
  /* I8: HOW LATE THE LIVE PATH BANKED. A measurement beside the two alarms:
     I7 says a raked hand is owed by nothing, I9 says an envelope still owes
     it, and I8 counts the hands whose rake landed more than five minutes after
     the hand. It carries violations 0 on purpose: lateness that has already
     resolved is read, not paged on. */
  SELECT 'I8_rake_banked_late', 0::bigint,
         jsonb_build_object(
           'hands', (SELECT count(*) FROM scope s
                      WHERE s.hand_at IS NOT NULL
                        AND s.created_at - s.hand_at > interval '5 minutes'),
           'chips', (SELECT COALESCE(round(sum(s.rake_amount), 2), 0) FROM scope s
                      WHERE s.hand_at IS NOT NULL
                        AND s.created_at - s.hand_at > interval '5 minutes'),
           'window_hours', p_hours,
           'means', 'rake banked more than five minutes after its hand was recorded: an envelope that completed late. Counted here, never raised.',
           'raises', 'never - this is a measurement, not an alarm. I7 and I9 are the alarms.');
END $function$;

-- 2. The audit's resolution note stops promising a repair job.
SELECT pg_temp.ca_patch('fn_rake_bbj_audit',
$a1f$Raked hands that were never banked are recovered by fn_rake_repair_unbanked; if this class returns, a new alert is raised rather than this one staying open.$a1f$,
$a1t$The rake of every accepted cash hand is owed by its post-commit envelope and banked by fn_ca_process_hand_post_commit_obligations; no job banks it afterwards, so if this class returns a new alert is raised rather than this one staying open.$a1t$);

-- 3. One read-only run of the new audit, for the proofs below.
CREATE TEMP TABLE _ca_rake_audit_now ON COMMIT DROP AS
SELECT * FROM public.fn_rake_bbj_invariants(2);

DO $verify$
DECLARE
  v_old   text;
  v_new   text;
  v_src   text;
  v_audit text;
  v_pair  text[];
  v_start integer;
  v_len   integer;
  v_block text;
  v_names text[];
  v_i5    jsonb;
  v_i7    jsonb;
  v_i9    jsonb;
  v_n5    bigint;
  v_n7    bigint;
  v_n9    bigint;
  v_owed  bigint;
BEGIN
  SELECT def INTO v_old FROM _ca_rake_audit_before;
  SELECT pg_get_functiondef(p.oid), p.prosrc INTO v_new, v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_invariants';

  -- (a) Everything this file did not mean to change is byte-identical: each
  --     block is cut out of the body this replaced and must be found, as is,
  --     in the new one.
  FOREACH v_pair SLICE 1 IN ARRAY ARRAY[
      ARRAY['  v_since timestamptz', '  /* Self-healing checks'],
      ARRAY['  SELECT r.bbj_min_players_dealt', '  BEGIN'],
      ARRAY['  RETURN QUERY', '  SELECT ''I5_drop_not_banked_to_pool'''],
      ARRAY['  SELECT ''I6_ledger_not_reconciled''', '  SELECT ''I7_raked_hand_never_banked'''],
      ARRAY['''hands'', (SELECT count(*) FROM scope s', '''window_hours'', p_hours,']
    ]
  LOOP
    v_start := position(v_pair[1] in v_old);
    IF v_start = 0 THEN
      RAISE EXCEPTION 'failed: anchor % is not in the body this replaced', v_pair[1];
    END IF;
    v_len := position(v_pair[2] in substr(v_old, v_start)) - 1;
    IF v_len <= 0 THEN
      RAISE EXCEPTION 'failed: anchor % does not follow % in the body this replaced', v_pair[2], v_pair[1];
    END IF;
    v_block := substr(v_old, v_start, v_len);
    IF position(v_block in v_new) = 0 THEN
      RAISE EXCEPTION 'failed: the block starting % changed; this file replaces only the grace, I5, I7 and I8 and adds I9', v_pair[1];
    END IF;
  END LOOP;

  -- (b) The schedule is not read, and no repair job is waited for.
  IF position('cron.' in v_src) > 0 OR position('job_run_details' in v_src) > 0 THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_invariants still reads the job scheduler';
  END IF;
  IF position('repair-unbanked' in v_src) > 0 OR position('_heal' in v_src) > 0 THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_invariants still waits for a repair job';
  END IF;

  -- (c) Same owner, volatility, definer and grants as before.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_invariants'
                    AND p.prosecdef AND p.provolatile = 's'
                    AND pg_get_userbyid(p.proowner) = 'postgres'
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_invariants lost its owner, volatility or grants';
  END IF;

  -- (d) It runs, every check answers, and both money windows are live: the
  --     grace is five minutes before this transaction, not two hours.
  SELECT array_agg(check_name ORDER BY check_name) INTO v_names FROM _ca_rake_audit_now;
  IF v_names IS DISTINCT FROM ARRAY['I1_drop_under_3_dealt', 'I2_drop_on_ineligible_variant',
       'I3_deductions_exceed_pot', 'I4_eligible_flop_no_drop', 'I5_drop_not_banked_to_pool',
       'I6_ledger_not_reconciled', 'I7_raked_hand_never_banked', 'I8_rake_banked_late',
       'I9_rake_owed_by_a_pending_envelope'] THEN
    RAISE EXCEPTION 'failed: the audit answered %', v_names;
  END IF;
  SELECT detail, violations INTO v_i5, v_n5 FROM _ca_rake_audit_now
   WHERE check_name = 'I5_drop_not_banked_to_pool';
  SELECT detail, violations INTO v_i7, v_n7 FROM _ca_rake_audit_now
   WHERE check_name = 'I7_raked_hand_never_banked';
  SELECT detail, violations INTO v_i9, v_n9 FROM _ca_rake_audit_now
   WHERE check_name = 'I9_rake_owed_by_a_pending_envelope';
  IF abs(extract(epoch FROM (v_i5->>'grace_until')::timestamptz - (now() - interval '5 minutes'))) > 1
     OR abs(extract(epoch FROM (v_i7->>'grace_until')::timestamptz - (now() - interval '5 minutes'))) > 1
     OR v_i5->>'grace_source' IS DISTINCT FROM 'writer'
     OR v_i7->>'grace_source' IS DISTINCT FROM 'writer' THEN
    RAISE EXCEPTION 'failed: a money window is not the writer grace (I5 %, I7 %)',
      v_i5->>'grace_until', v_i7->>'grace_until';
  END IF;

  -- (e) Both directions on live rows, read only. I9 counts exactly the
  --     envelopes that still owe rake past the grace (up to its sample of
  --     20), and I7 never counts a hand such an envelope still owes.
  SELECT least(count(*), 20) INTO v_owed
    FROM hand_atomic_commits c
   WHERE c.post_commit_payload IS NOT NULL
     AND c.post_commit_completed_at IS NULL
     AND c.committed_at < now() - interval '5 minutes'
     AND (jsonb_typeof(c.post_commit_payload->'rake') = 'object'
          OR jsonb_typeof(c.post_commit_payload->'bbj_contribution') = 'object');
  IF v_n9 IS DISTINCT FROM v_owed THEN
    RAISE EXCEPTION 'failed: I9 counted % but % envelopes still owe rake past the grace', v_n9, v_owed;
  END IF;
  IF EXISTS (SELECT 1
               FROM jsonb_array_elements(COALESCE(v_i7->'hands', '[]'::jsonb)) h
               JOIN hand_atomic_commits c ON c.hand_id = (h->>'hand')::uuid
              WHERE c.post_commit_payload IS NOT NULL
                AND c.post_commit_completed_at IS NULL) THEN
    RAISE EXCEPTION 'failed: I7 counted a hand whose envelope still owes it';
  END IF;

  -- (f) The audit's note, its money set and its grants.
  SELECT p.prosrc INTO v_audit
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_audit';
  IF position('recovered by fn_rake_repair_unbanked' in v_audit) > 0
     OR position('banked by fn_ca_process_hand_post_commit_obligations' in v_audit) = 0 THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_audit still promises a repair job';
  END IF;
  IF position('(''I3_deductions_exceed_pot'',''I5_drop_not_banked_to_pool'',''I7_raked_hand_never_banked'')' in v_audit) = 0 THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_audit money set moved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_rake_bbj_audit'
                    AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'failed: fn_rake_bbj_audit lost its owner or grants';
  END IF;

  RAISE NOTICE 'rake audit at apply: I5 %, I7 %, I9 % (a non-zero is a finding, not a reason to refuse)',
    v_n5, v_n7, v_n9;
END $verify$;

COMMIT;
