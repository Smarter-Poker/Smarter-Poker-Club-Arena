-- =====================================================================
-- Seven tournaments cannot finish. This migration fixes three root causes
-- and completes three of them. It pays nobody directly.
--
-- WHAT IS STUCK (measured 2026-09-20 23:31 UTC, production)
--   Seven events are RUNNING with a full, untouched prize escrow:
--     c905f397 Sunday $200 Deep Stack   21,080.00 prize /  260.00 fee
--     ee728115 Saturday Night Big Stack  3,150.00 prize /  350.00 fee
--     27a4b721 Friday Night Feature      2,052.00 prize /  228.00 fee
--     f670ca7c 100 Chip Spin PLO5          200.00 prize /   24.00 fee
--     5090c03b  50 Chip Spin PLO4          100.00 prize /   12.00 fee
--     18c95ce7  10 Chip Spin PLO6           20.00 prize /    2.40 fee
--     c59c8fe4   1 Chip Spin PLO5            2.00 prize /    0.24 fee
--   Total 26,604.00 prize + 876.64 fee = 27,480.64. Nothing has been paid:
--   prize_out, fee_out, refund_prize and refund_fee are 0.00 on all seven,
--   and there are zero payouts, obligations, place batches, terminal
--   receipts and rake settlements. Every beneficiary is a horse; law 10.5
--   applies unchanged - they are paid exactly as humans are.
--
-- HOW THE REFUSAL ACTUALLY WORKS (read from the live catalogue, and proved
-- by a rolled-back probe that called fn_complete_tournament_terminal on all
-- seven; the probe aborted by design and committed nothing)
--   The engine calls fn_complete_tournament_terminal(id, winner, 'places').
--   That runs fn_complete_tournament_terminal_pre_seat_guard, which pays the
--   places, then settles the rake, then - if the rake refuses with one of
--   four accepted reasons - routes the fee to legacy custody. Every step is
--   ONE transaction, so a refusal at the fee stage rolls the prizes back too.
--   That is why prize_balance is still full.
--
--   The three MTTs raise, verbatim:
--     "legacy fee custody requires exact unpaid named source and completed
--      player banks"                                     (from the hold)
--   The four Spins never reach the fee stage at all; they raise:
--     "tournament <id> has no complete durable elimination sequence
--      (1/1 of 2)"                                       (from the places)
--
-- THE THREE ROOT CAUSES FIXED HERE
--
-- R1  fn_award_satellite_seat recorded tournament_refund_entitlements
--     .refund_wallet_club_id as the HOST club for a cross-club satellite
--     seat, up to the fee cutover 2026-09-17T18:24:02.831517Z. The capture
--     asserts the contributor club equals tournament_players.club_id and so
--     refuses all 142 stranded records with
--     tournament_fee_charge_evidence_mismatch.
--     Measured: 142/142 have refund_wallet_club_id = the host club and
--     tp.club_id = some other club; EVERY other assertion in that function
--     passes 0/142; and fn_accounting_earning_contract yields a valid
--     contract for the player's club 149/149 but for the host club only
--     88/149. The host club is not merely unverifiable, it is wrong.
--     FIX: for entitlement_kind = 'satellite_seat' the contributor club is
--     the REGISTRATION's club, and refund_wallet_club_id is verified
--     separately, against the charge ledger's own club - which it equals
--     142/142. This ADDS a check rather than dropping one.
--
-- R2  The capture that exists for exactly these pre-cutover records,
--     fn_ca_capture_tournament_fee_from_recorded_evidence, was reachable
--     ONLY from fn_ca_begin_legacy_fee_resolution, which returns
--     immediately unless the event already holds a custody obligation - and
--     a custody obligation can only be created for an event named in a
--     hard-coded list. None of the seven is in that list, so the purpose-
--     built reader was never called for any of them. That is the
--     reachability defect behind every one of the 14 fees now sitting in
--     custody: all 14 were held for reason
--     'tournament_fee_sources_require_reconciliation', and none is resolved.
--     FIX: fn_settle_tournament_rake captures pre-cutover positive fee
--     records that have no batch, on the ordinary close, before it asks for
--     the net plan. A record that cannot prove itself is left exactly as it
--     was, so the plan below still refuses in the same words and the
--     existing custody route is unchanged. This cannot make anything worse.
--
-- R3  fn_stamp_tournament_elimination_sequence stamps only on a transition
--     INTO 'eliminated'. A row that was already 'eliminated' when the
--     trigger was introduced can therefore never acquire a stamp, and any
--     direct repair is refused with 'elimination_sequence is database-owned'
--     (42501). Each of the four Spins has its 2026-09-08 third-place bust
--     unstamped while its second-place bust, recorded on 2026-09-14, is
--     stamped - so the settler counts 1 sequence for 2 eliminations and
--     refuses.
--     Measured: 324,688 eliminated rows platform-wide carry a NULL
--     sequence, across 139,885 tournaments, and the newest is
--     2026-09-09 23:31:43 - a CLOSED historical set, not an ongoing leak.
--     FIX: the trigger may now stamp a row that is already eliminated and
--     holds NULL. Changing a stamp that exists is still refused, so a
--     sequence remains write-once and database-owned. Only the four Spin
--     rows are corrected here; the other 324,684 belong to events that
--     already settled and are deliberately left alone.
--
-- WHAT THIS MIGRATION DOES NOT DO, AND WHY
--   It does not widen fn_ca_legacy_fee_custody_cohort. The proposal was to
--   replace its hard-coded list with "every positive fee predates the first
--   observed accounting agreement". Measured against production, that
--   predicate admits 156,926 tournaments carrying 792,479.09 of fees into
--   the custody escape hatch. Tightened to events that are still open, have
--   no batch, no rake settlement and no terminal receipt, it admits 34
--   events and 152.56 - but it STILL would not complete a single Spin,
--   because fn_ca_hold_legacy_tournament_fee additionally refuses any spin
--   for which fn_ca_sep8_spin_original_fee_proof returns NULL, and that
--   function opens with its OWN hard-coded list of five tournament ids.
--   Widening one list without the other changes the width of an escape
--   hatch and completes nothing. That is pure risk, so it is not done here.
--   The four Spins (322.00 prize, 38.64 fee) stay blocked; see the report.
--
--   It pays nobody and writes no wallet row. It replaces three functions
--   and sets four integer columns. The money is released by the platform's
--   own path - the engine's existing retry of
--   fn_complete_tournament_terminal - which is already running against
--   these events every few minutes.
--
-- DDL POLICY (Club Arena CLAUDE.md section 2)
--   One change, one transaction, one BEGIN/COMMIT: one PostgREST reload.
--   Do NOT apply between :50 and :03 UTC - the break-window event triggers
--   will roll the whole thing back. Apply once; never in a retry loop.
-- =====================================================================

-- THIS FILE CREATES NO PERSISTENT OBJECT, so it states its own proof - the
-- convention tests/a-merged-migration-must-be-live.law.test.ts binds from
-- 20260920 onward. Nothing in pg_proc or pg_class appears for a patched
-- function body, a revoked grant or an updated row, so the reader is told
-- exactly what to run. Every expression below was run read-only against
-- production on 2026-09-25 and every one returned true.
-- @live-proof: (SELECT position('OLD.elimination_sequence IS NULL' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_stamp_tournament_elimination_sequence')
-- @live-proof: (SELECT position('tp.club_id IS DISTINCT FROM club' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_capture_tournament_fee_from_recorded_evidence')
-- @live-proof: (SELECT position('fn_ca_capture_tournament_fee_from_recorded_evidence' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_rake')
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------
-- 0. PRE-CONDITIONS. Nothing here is assumed; if the board has moved
--    underneath this file, it aborts rather than acting on stale facts.
--    This is also the no-double-pay proof: the fix cannot make an
--    already-paid event payable twice because none of the seven has been
--    paid anything at all, and that is asserted, not asserted-by-comment.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_mtts  uuid[] := ARRAY['c905f397-6842-4322-8c61-89a108ad414b',
                          'ee728115-9db0-4057-881a-b6450985262c',
                          '27a4b721-050b-4160-bb53-d595b9e38a05']::uuid[];
  v_spins uuid[] := ARRAY['f670ca7c-5134-4a22-9426-eea2601c300a',
                          '5090c03b-2b36-456a-b301-485493280a51',
                          '18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6',
                          'c59c8fe4-a6a8-41f5-b436-c9c55dc0f088']::uuid[];
  v_all   uuid[] := v_mtts || v_spins;
  n bigint; v_prize numeric; v_fee numeric;
BEGIN
  -- all seven still exist and are still RUNNING
  SELECT count(*) INTO n FROM public.tournaments
   WHERE id = ANY(v_all) AND upper(status) = 'RUNNING';
  IF n <> 7 THEN
    RAISE EXCEPTION 'expected 7 RUNNING events, found %', n; END IF;

  -- NOTHING HAS BEEN PAID. Five independent records, all empty.
  SELECT count(*) INTO n FROM public.tournament_payouts WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'a payout already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_obligations WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'an obligation already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_place_settlement_batches WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'a place batch already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_terminal_settlements WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'a terminal receipt already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_rake_settlements WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'a rake settlement already exists (%); refusing', n; END IF;

  -- the escrow is untouched and exactly equals the advertised pool
  SELECT count(*) INTO n
    FROM public.tournament_escrow e JOIN public.tournaments t ON t.id = e.tournament_id
   WHERE e.tournament_id = ANY(v_all)
     AND e.enforced
     AND e.prize_out = 0 AND e.fee_out = 0
     AND e.refund_prize = 0 AND e.refund_fee = 0
     AND e.closed_at IS NULL AND e.terminal_closed_at IS NULL
     AND e.prize_balance = round(t.prize_pool, 2);
  IF n <> 7 THEN
    RAISE EXCEPTION 'escrow is not in the untouched state for all 7 (matched %)', n; END IF;

  SELECT sum(prize_balance), sum(fee_balance) INTO v_prize, v_fee
    FROM public.tournament_escrow WHERE tournament_id = ANY(v_all);
  IF v_prize <> 26604.00 OR v_fee <> 876.64 THEN
    RAISE EXCEPTION 'escrow totals moved: prize % (expected 26604.00), fee % (expected 876.64)',
      v_prize, v_fee; END IF;

  -- R1 is still exactly 142 records, and still fails for exactly one reason
  SELECT count(*) INTO n
    FROM public.rake_records r
   WHERE r.tournament_id = ANY(v_mtts) AND r.is_tournament AND r.hand_id IS NULL
     AND r.source = 'fn_award_satellite_seat'
     AND NOT EXISTS (SELECT 1 FROM public.accounting_tournament_fee_batches b
                      WHERE b.rake_record_id = r.id);
  IF n <> 142 THEN
    RAISE EXCEPTION 'expected 142 stranded satellite fee records, found %', n; END IF;

  SELECT count(*) INTO n
    FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id = e.registration_id
   WHERE e.tournament_id = ANY(v_mtts) AND e.entitlement_kind = 'satellite_seat'
     AND e.refund_wallet_club_id IS DISTINCT FROM tp.club_id;
  IF n < 142 THEN
    RAISE EXCEPTION 'the host-club shape no longer covers the 142 (found %)', n; END IF;

  -- R3 is still exactly one unstamped bust per Spin
  SELECT count(*) INTO n FROM public.tournament_players
   WHERE tournament_id = ANY(v_spins) AND status = 'eliminated' AND elimination_sequence IS NULL;
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 unstamped Spin busts, found %', n; END IF;

  RAISE NOTICE 'pre-conditions hold: 7 events, 27480.64 held, nothing paid';
END
$pre$;

-- ---------------------------------------------------------------------
-- 1. R3, the cause: a row already 'eliminated' can never acquire the stamp
--    this trigger exists to give it. Asserted text substitution against the
--    live catalogue - the refusal branch is kept, a narrower branch is
--    added in front of it.
-- ---------------------------------------------------------------------
DO $mig1$
DECLARE
  src text; out text; anchor text; repl text; hits int;
BEGIN
  src := pg_get_functiondef('public.fn_stamp_tournament_elimination_sequence()'::regprocedure);

  anchor := $a$  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
$a$;
  hits := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'R3 anchor appears % times, expected exactly 1', hits; END IF;

  repl := $r$  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text = 'eliminated'
        AND OLD.elimination_sequence IS NULL
        AND NEW.elimination_sequence IS NOT NULL THEN
    -- 2026-09-20. A row that was already 'eliminated' when this trigger was
    -- introduced can never transition INTO 'eliminated' again, so it could
    -- never acquire the stamp this trigger exists to give it, and every
    -- repair was refused below as database-owned. Permit exactly that one
    -- acquisition: NULL -> a value, on a row that is already eliminated.
    -- Changing a stamp that EXISTS is still refused, so a sequence is still
    -- write-once; tournament_players_one_elimination_sequence keeps it
    -- unique within the event and the CHECK keeps it positive.
    NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
$r$;

  out := replace(src, anchor, repl);
  IF length(out) <> length(src) - length(anchor) + length(repl) THEN
    RAISE EXCEPTION 'R3 substitution changed more than the anchor'; END IF;

  -- every other guard survives verbatim
  IF position($g$'elimination_sequence is database-owned'$g$ in out) = 0
     OR position($g$USING ERRCODE = '42501'$g$ in out) = 0
     OR position($g$IF TG_OP = 'INSERT' THEN$g$ in out) = 0
     OR position($g$ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'$g$ in out) = 0
     OR position($g$nextval($g$ in out) = 0 THEN
    RAISE EXCEPTION 'R3 substitution lost a guard'; END IF;

  EXECUTE out;
  RAISE NOTICE 'R3 fixed: an already-eliminated row may acquire a missing stamp';
END
$mig1$;

-- ---------------------------------------------------------------------
-- 2. R3, the damage: stamp the four Spin busts, order-preserving.
--    The unique index is per (tournament_id, elimination_sequence), so a
--    value BELOW the event's existing stamp is free and is the correct
--    one: these busts happened on 2026-09-08, six days before the bust
--    that is already stamped. Stamping them above it would invert the
--    finishing order of two horses, which law 10.5 forbids as surely for
--    them as for anyone else.
-- ---------------------------------------------------------------------
DO $mig2$
DECLARE
  v_spins uuid[] := ARRAY['f670ca7c-5134-4a22-9426-eea2601c300a',
                          '5090c03b-2b36-456a-b301-485493280a51',
                          '18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6',
                          'c59c8fe4-a6a8-41f5-b436-c9c55dc0f088']::uuid[];
  n bigint; bad bigint;
BEGIN
  -- each Spin must have exactly one stamped bust to anchor against, and the
  -- unstamped bust must genuinely be the EARLIER one
  SELECT count(*) INTO n FROM (
    SELECT tp.tournament_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = ANY(v_spins) AND tp.status = 'eliminated'
     GROUP BY tp.tournament_id
    HAVING count(*) = 2
       AND count(tp.elimination_sequence) = 1
       AND min(tp.eliminated_at) FILTER (WHERE tp.elimination_sequence IS NULL)
         < min(tp.eliminated_at) FILTER (WHERE tp.elimination_sequence IS NOT NULL)
  ) q;
  IF n <> 4 THEN
    RAISE EXCEPTION 'the four Spins are not in the expected 2-bust shape (matched %)', n; END IF;

  WITH anchor AS (
    SELECT tp.tournament_id, min(tp.elimination_sequence) AS min_seq
      FROM public.tournament_players tp
     WHERE tp.tournament_id = ANY(v_spins) AND tp.elimination_sequence IS NOT NULL
     GROUP BY tp.tournament_id
  ), target AS (
    SELECT tp.id,
           a.min_seq - row_number() OVER (PARTITION BY tp.tournament_id
                                          ORDER BY tp.eliminated_at DESC, tp.id DESC) AS new_seq
      FROM public.tournament_players tp
      JOIN anchor a ON a.tournament_id = tp.tournament_id
     WHERE tp.status = 'eliminated' AND tp.elimination_sequence IS NULL
  )
  UPDATE public.tournament_players tp
     SET elimination_sequence = t.new_seq
    FROM target t
   WHERE tp.id = t.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected to stamp 4 rows, stamped %', n; END IF;

  -- the sequence is now complete, distinct, positive and in true bust order
  SELECT count(*) INTO bad FROM (
    SELECT tp.tournament_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = ANY(v_spins) AND tp.status = 'eliminated'
     GROUP BY tp.tournament_id
    HAVING count(*) <> count(tp.elimination_sequence)
        OR count(DISTINCT tp.elimination_sequence) <> count(*)
        OR min(tp.elimination_sequence) <= 0
  ) q;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'the stamped sequence is still not complete/distinct/positive (% events)', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.tournament_players a
    JOIN public.tournament_players b
      ON b.tournament_id = a.tournament_id AND b.id <> a.id AND b.status = 'eliminated'
   WHERE a.tournament_id = ANY(v_spins) AND a.status = 'eliminated'
     AND a.eliminated_at < b.eliminated_at
     AND a.elimination_sequence > b.elimination_sequence;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'stamping inverted the bust order in % pair(s)', bad; END IF;

  RAISE NOTICE 'R3 damage settled: 4 Spin busts stamped in true order';
END
$mig2$;

-- ---------------------------------------------------------------------
-- 3. R1: a satellite seat's earning club is the registration's club.
--    refund_wallet_club_id keeps its real job - the refund destination -
--    and is now verified against the charge ledger's own club, which it
--    equals 142/142. Net effect: one assertion is made correct, and one
--    new assertion is added.
-- ---------------------------------------------------------------------
DO $mig3$
DECLARE
  src text; out text; a1 text; r1 text; a2 text; r2 text; hits int; expected int;
BEGIN
  src := pg_get_functiondef(
    'public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure);

  ---- 3a. build the contributor with the right club -------------------
  a1 := $a$      'player_id', e.user_id, 'club_id', e.refund_wallet_club_id, 'registration_id', reg,
$a$;
  hits := (length(src) - length(replace(src, a1, ''))) / length(a1);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'R1 contributor anchor appears % times, expected 1', hits; END IF;

  r1 := $r$      'player_id', e.user_id,
      -- 2026-09-20. A satellite seat's contributor club is the
      -- REGISTRATION's club: the club whose member actually played, and the
      -- only club for which fn_accounting_earning_contract resolves (149/149
      -- against 88/149 for the host club). fn_award_satellite_seat wrote
      -- refund_wallet_club_id as the HOST club until the 2026-09-17 cutover;
      -- that is a refund DESTINATION, not an earning scope, and it is
      -- verified as one in the evidence loop below. After the cutover the
      -- two are equal, so this changes nothing for a post-cutover record.
      'club_id', CASE WHEN e.entitlement_kind = 'satellite_seat'
                      THEN (SELECT x.club_id FROM public.tournament_players x WHERE x.id = reg)
                      ELSE e.refund_wallet_club_id END,
      'registration_id', reg,
$r$;

  ---- 3b. verify the refund destination on its own terms --------------
  a2 := $a$     OR e.refund_wallet_club_id IS DISTINCT FROM club OR e.source_ledger_id IS DISTINCT FROM ledger_id
$a$;
  hits := (length(src) - length(replace(src, a2, ''))) / length(a2);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'R1 verification anchor appears % times, expected 1', hits; END IF;

  r2 := $r$     OR (CASE WHEN e.entitlement_kind = 'satellite_seat'
              THEN e.refund_wallet_club_id IS DISTINCT FROM l.club_id
              ELSE e.refund_wallet_club_id IS DISTINCT FROM club END)
     OR e.source_ledger_id IS DISTINCT FROM ledger_id
$r$;

  expected := length(src) - length(a1) + length(r1) - length(a2) + length(r2);
  out := replace(replace(src, a1, r1), a2, r2);
  IF length(out) <> expected THEN
    RAISE EXCEPTION 'R1 substitution changed more than its two anchors'; END IF;

  -- The Spin contributor build is a DIFFERENT line and must be untouched:
  -- a Spin entitlement is a wallet_charge, where refund_wallet_club_id is
  -- already the player's own club.
  hits := (length(out) - length(replace(out,
    $g$        'player_id', e.user_id, 'club_id', e.refund_wallet_club_id, 'registration_id', tp.id,$g$, ''))) /
    length($g$        'player_id', e.user_id, 'club_id', e.refund_wallet_club_id, 'registration_id', tp.id,$g$);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'the Spin contributor build was disturbed (% hits)', hits; END IF;

  -- every other guard in this 19KB money function survives verbatim
  IF position($g$tp.club_id IS DISTINCT FROM club$g$ in out) = 0
     OR position($g$tournament_fee_charge_evidence_mismatch$g$ in out) = 0
     OR position($g$tournament_fee_satellite_evidence_mismatch$g$ in out) = 0
     OR position($g$tournament_fee_wallet_evidence_mismatch$g$ in out) = 0
     OR position($g$tournament_fee_ticket_evidence_mismatch$g$ in out) = 0
     OR position($g$tournament_fee_amount_evidence_mismatch$g$ in out) = 0
     OR position($g$spin_fee_charge_evidence_mismatch$g$ in out) = 0
     OR position($g$spin_fee_reserve_evidence_mismatch$g$ in out) = 0
     OR position($g$tournament_fee_contract_scope_mismatch$g$ in out) = 0
     OR position($g$tournament_fee_credit_not_conserved$g$ in out) = 0
     OR position($g$tournament_fee_contributor_invalid$g$ in out) = 0
     OR position($g$tournament_fee_contributor_count_invalid$g$ in out) = 0
     OR position($g$tournament_fee_is_the_producers_to_capture$g$ in out) = 0
     OR position($g$tournament_fee_already_has_a_batch$g$ in out) = 0
     OR position($g$tournament_fee_event_is_not_live$g$ in out) = 0
     OR position($g$tournament_fee_reconciled_batch_would_not_satisfy_the_plan$g$ in out) = 0
     OR position($g$l.amount IS DISTINCT FROM e.gross$g$ in out) = 0
     OR position($g$e.created_at IS DISTINCT FROM charged_at$g$ in out) = 0
     OR position($g$charged_at > r.created_at$g$ in out) = 0
     OR position($g$pg_advisory_xact_lock$g$ in out) = 0 THEN
    RAISE EXCEPTION 'R1 substitution lost a guard'; END IF;

  EXECUTE out;
  RAISE NOTICE 'R1 fixed: a satellite seat earns for the club that played it';
END
$mig3$;

-- ---------------------------------------------------------------------
-- 4. R2: make the capture reachable on the ordinary close.
--    fn_settle_tournament_rake already stamps fees charged in its OWN
--    transaction. A fee charged before the cutover was never stamped by
--    anyone, and the reader built for it sat behind legacy custody. Call it
--    here. A record that cannot prove itself is left untouched, so the net
--    plan below still raises the same 55000 and the custody route behaves
--    exactly as it does today.
-- ---------------------------------------------------------------------
DO $mig4$
DECLARE
  src text; out text; anchor text; repl text; hits int;
BEGIN
  src := pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure);

  anchor := $a$  PERFORM public.fn_stamp_accounting_tournament_fee(v_raw.id);
 END LOOP;
$a$;
  hits := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'R2 anchor appears % times, expected exactly 1', hits; END IF;

  repl := $r$  PERFORM public.fn_stamp_accounting_tournament_fee(v_raw.id);
 END LOOP;
 -- 2026-09-20. A fee charged BEFORE the cutover was never captured by a
 -- producer, and fn_ca_capture_tournament_fee_from_recorded_evidence - the
 -- reader built for exactly that record - was reachable only from
 -- fn_ca_begin_legacy_fee_resolution, which does nothing unless the event
 -- already holds a custody obligation, which only a named event can get.
 -- So the reader was never called for an event that was not on a list.
 -- Call it here, on the ordinary close, while the event is COMPLETING.
 -- Each capture takes its own subtransaction: one that cannot prove itself
 -- rolls back alone and leaves its record exactly as it was, so the net
 -- plan below still refuses in the same words and legacy custody still
 -- receives the same reason. This can only add proof, never remove it.
 FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
  WHERE r.tournament_id=p_tournament_id AND r.is_tournament
    AND r.rake_amount>0 AND r.hand_id IS NULL AND r.created_at<c.starts_at
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)
  ORDER BY r.id LOOP
  BEGIN
   PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence(v_raw.id);
  EXCEPTION WHEN OTHERS THEN
   -- Not silence: the reason travels to the log, and the refusal that
   -- follows is unchanged. "Could not prove it" is not "there was nothing".
   RAISE NOTICE 'pre-cutover fee % left uncaptured: % (%)', v_raw.id, SQLERRM, SQLSTATE;
  END;
 END LOOP;
$r$;

  out := replace(src, anchor, repl);
  IF length(out) <> length(src) - length(anchor) + length(repl) THEN
    RAISE EXCEPTION 'R2 substitution changed more than the anchor'; END IF;

  -- every other guard in the rake settler survives verbatim
  IF position($g$tournament_fee_net_invalid$g$ in out) = 0
     OR position($g$rake attribution incomplete: %$g$ in out) = 0
     OR position($g$tournament_fee_sources_require_reconciliation$g$ in out) = 0
     OR position($g$accounting_terms_not_observed$g$ in out) = 0
     OR position($g$tournament_fee_not_captured_by_original_producer$g$ in out) = 0
     OR position($g$tournament_fee_exact_bank_receipt_required$g$ in out) = 0
     OR position($g$tournament_fee_legacy_treasury_leg_requires_adjustment$g$ in out) = 0
     OR position($g$tournament_fee_disposition_receipt_missing$g$ in out) = 0
     OR position($g$tournament_accrual_closed_period_requires_adjustment$g$ in out) = 0
     OR position($g$settlement_attribution_incomplete$g$ in out) = 0
     OR position($g$fn_ca_begin_legacy_fee_resolution$g$ in out) = 0
     OR position($g$fn_ca_lock_settlement_lane_global$g$ in out) = 0
     OR position($g$fn_recognize_accounting_tournament_fees$g$ in out) = 0
     OR position($g$SET statement_timeout TO '30s'$g$ in out) = 0 THEN
    RAISE EXCEPTION 'R2 substitution lost a guard'; END IF;

  EXECUTE out;
  RAISE NOTICE 'R2 fixed: a pre-cutover fee is captured on the ordinary close';
END
$mig4$;

-- ---------------------------------------------------------------------
-- 5. POST-CONDITIONS. Prove the three functions are what we meant them to
--    be, and - the important one - prove this migration moved no money.
-- ---------------------------------------------------------------------
DO $post$
DECLARE
  v_mtts  uuid[] := ARRAY['c905f397-6842-4322-8c61-89a108ad414b',
                          'ee728115-9db0-4057-881a-b6450985262c',
                          '27a4b721-050b-4160-bb53-d595b9e38a05']::uuid[];
  v_spins uuid[] := ARRAY['f670ca7c-5134-4a22-9426-eea2601c300a',
                          '5090c03b-2b36-456a-b301-485493280a51',
                          '18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6',
                          'c59c8fe4-a6a8-41f5-b436-c9c55dc0f088']::uuid[];
  v_all   uuid[] := v_mtts || v_spins;
  n bigint; v_prize numeric; v_fee numeric; d text;
BEGIN
  -- the three functions carry their new logic
  d := pg_get_functiondef('public.fn_stamp_tournament_elimination_sequence()'::regprocedure);
  IF position($g$OLD.elimination_sequence IS NULL$g$ in d) = 0
     OR position($g$'elimination_sequence is database-owned'$g$ in d) = 0 THEN
    RAISE EXCEPTION 'the elimination stamp is not in its intended state'; END IF;

  d := pg_get_functiondef(
    'public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure);
  IF position($g$WHEN e.entitlement_kind = 'satellite_seat'$g$ in d) = 0
     OR position($g$tp.club_id IS DISTINCT FROM club$g$ in d) = 0 THEN
    RAISE EXCEPTION 'the fee capture is not in its intended state'; END IF;

  d := pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure);
  IF position($g$fn_ca_capture_tournament_fee_from_recorded_evidence$g$ in d) = 0 THEN
    RAISE EXCEPTION 'the rake settler is not in its intended state'; END IF;

  -- the four Spins now satisfy the settler's completeness guard
  SELECT count(*) INTO n FROM (
    SELECT tp.tournament_id FROM public.tournament_players tp
     WHERE tp.tournament_id = ANY(v_spins) AND tp.status = 'eliminated'
     GROUP BY tp.tournament_id
    HAVING count(*) = count(tp.elimination_sequence)
       AND count(DISTINCT tp.elimination_sequence) = count(*)
  ) q;
  IF n <> 4 THEN
    RAISE EXCEPTION 'the Spin elimination sequence is still incomplete (% of 4 ok)', n; END IF;

  -- NO MONEY MOVED. Nothing was paid, nothing was captured, nothing was
  -- settled, and the escrow is exactly where the pre-conditions found it.
  SELECT count(*) INTO n FROM public.tournament_payouts WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % payout row(s)', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_obligations WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % obligation row(s)', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_rake_settlements WHERE tournament_id = ANY(v_all);
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % rake settlement(s)', n; END IF;
  -- 17 fee batches existed for these seven before this migration (the
  -- records that WERE captured normally: 10 on c905f397, 5 on ee728115,
  -- 2 on 27a4b721, none on the Spins). This migration captures nothing -
  -- it only makes capture possible for the settlement that follows.
  SELECT count(*) INTO n FROM public.accounting_tournament_fee_batches
   WHERE tournament_id = ANY(v_all);
  IF n <> 17 THEN
    RAISE EXCEPTION 'this migration changed the fee batch count: % (expected 17)', n; END IF;

  SELECT sum(prize_balance), sum(fee_balance) INTO v_prize, v_fee
    FROM public.tournament_escrow WHERE tournament_id = ANY(v_all);
  IF v_prize <> 26604.00 OR v_fee <> 876.64 THEN
    RAISE EXCEPTION 'this migration moved escrow: prize %, fee %', v_prize, v_fee; END IF;

  SELECT count(*) INTO n FROM public.tournaments
   WHERE id = ANY(v_all) AND upper(status) = 'RUNNING';
  IF n <> 7 THEN
    RAISE EXCEPTION 'this migration changed a tournament status'; END IF;

  RAISE NOTICE 'post-conditions hold: 3 functions replaced, 4 rows stamped, 0.00 moved';
  RAISE NOTICE 'the three MTTs are now expected to complete on the engine''s next retry';
  RAISE NOTICE 'the four Spins remain blocked at the fee custody gate - see the header';
END
$post$;

COMMIT;

-- =====================================================================
-- AFTER APPLYING
--
--   Nothing else needs to be run. The engine retries
--   fn_complete_tournament_terminal against these events continuously (the
--   three MTTs were last refused at 23:32:10, 23:32:10 and 23:14:05 UTC on
--   2026-09-20). The next retry should capture the 142 records, prove the
--   net plan, attribute 607.00 of fees to the clubs whose members actually
--   played, pay 26,282.00 of prizes and close the three events. No
--   settlement needs to be triggered by hand; if one ever does, the
--   platform's own idempotent entry point is
--   fn_complete_tournament_terminal(id, winner_id, 'places').
--
--   Watch, do not assume:
--     SELECT left(id::text,8), status, ended_at FROM tournaments
--      WHERE id IN ('c905f397-6842-4322-8c61-89a108ad414b',
--                   'ee728115-9db0-4057-881a-b6450985262c',
--                   '27a4b721-050b-4160-bb53-d595b9e38a05');
--     SELECT left(tournament_id::text,8), prize_balance, fee_balance, prize_out
--       FROM tournament_escrow WHERE tournament_id IN (...);
--   Completion means status COMPLETED, prize_balance 0.00 and a
--   tournament_terminal_settlements row - not a quiet alert.
--
--   STILL OPEN AFTER THIS (report, not paperwork):
--     * The four Spins: 322.00 prize and 38.64 fee. They will clear the
--       elimination guard and stop at fn_ca_hold_legacy_tournament_fee,
--       which needs BOTH fn_ca_legacy_fee_custody_cohort AND
--       fn_ca_sep8_spin_original_fee_proof to stop being hard-coded lists.
--       That is its own piece of work; see the header for why it is not
--       bolted on here.
--     * 324,684 other eliminated rows still carry a NULL elimination
--       sequence. Their events are settled and their positions are frozen;
--       re-deriving them is what the settler's "fails closed" rule exists
--       to prevent. Left alone deliberately.
--     * 14 fees remain held in custody, all for reason
--       'tournament_fee_sources_require_reconciliation', none resolved.
--       R2 is the reachability defect that put several of them there; with
--       it fixed they are now candidates for real attribution rather than
--       an indefinite hold.
-- =====================================================================
