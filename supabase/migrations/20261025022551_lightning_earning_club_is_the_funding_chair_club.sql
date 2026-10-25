-- 20261025022551_lightning_earning_club_is_the_funding_chair_club.sql
--
-- A LIGHTNING HAND EARNS FOR THE CLUB WHOSE WALLET FUNDED THE CHAIR.
--
-- THE DEFECT (live since 2026-10-23 22:49:44 UTC)
-- fn_cash_earning_club's Lightning branch returned cash_player_session.club_id.
-- fn_cash_session_open stamps that column with the TABLE's club (tables.club_id),
-- which on a union-hosted Lightning game is the union itself (Midway Union,
-- fade0000-0000-0000-0000-000000000001), never the member club whose
-- club_members.chip_balance atomic_table_buyin debited (v_seat_club, the same
-- club it writes to table_seats.club_id and cash_participant_funding_receipts).
-- After 20261023224834_midway_lightning_fill_draws_from_every_union_club the
-- Lightning players are members of Deep Stack / Felt / KINGS, so every
-- rake_attributions row was written with club_id = Midway Union and the
-- settler (fn_credit_agent_commissions_batch -> fn_accounting_earning_contract
-- -> fn_accounting_terms_at('club_members','<Midway Union>:<player>')) refuses
-- it with accounting_terms_not_observed (55000).
--
-- Measured read-only 2026-10-24/25: every open union-hosted Lightning session
-- (343) carries club_id = Midway Union while its anchor chair carries the
-- member club the buy-in debited; over 9,159 Lightning player-hands in 15
-- minutes, 8,958 had a live anchor chair and its club agreed with the chair
-- the Classic rule reads, 0 disagreed, and none was a union club. The other
-- ~2-5% are players whose anchor chair row was already gone when queried
-- (session closed seconds after the hand); each still had exactly one
-- immutable buy-in funding receipt on the anchor seat naming the member club.
--
-- THE FIX (reader only)
-- The Lightning branch's own query now also reads the funding evidence of the
-- original pool session, the same rule the Classic branch uses:
--   chair: the anchor chair (lightning_pool_session.anchor_seat_id), same
--          player, live at the hand's recorded start; its table_seats.club_id
--          is the wallet club the buy-in debited;
--   paid:  that chair's immutable buy-in receipt
--          (cash_participant_funding_receipts, operation_kind 'buyin', same
--          seat/player/table, occupancy joined before the pool entry), read
--          through the partial index cash_participant_funding_buyin_table.
-- chair decides when it is exactly one club and passes the UNCHANGED
-- validation (non-union, or the union / a member of p_union_id); paid decides
-- only when no chair row exists, under the same validation; otherwise the
-- original cash_player_session reader decides exactly as before, so no hand
-- that banks today can start raising inside its commit. Both are LEFT JOINs
-- in the one query the branch already runs: no extra scan on the commit path.
--
-- WHY NOT THE STAMP. fn_cash_session_open is shared by every cash session
-- (859 open Classic union sessions are stamped the same way and are read by
-- ca_player_stats_cash_sessions and fn_lightning_original_pnl_proof), and a
-- stamp fix leaves the 343 already-open Lightning sessions wrong until they
-- close. The reader fix is the smallest change that makes the next Lightning
-- hand attribute correctly. No other function is replaced; Classic, private,
-- retired-custody and validation paths are byte-for-byte unchanged.
--
-- No table, row, balance, ledger, attribution or receipt is written. Already
-- written rake_attributions are NOT repaired here (they are immutable); see
-- the PR for the reviewed correction they need.
--
-- Proven in one rolled-back production transaction (see PR): for a refused
-- Lightning hand the old reader returned Midway Union (terms: not observed)
-- and the new reader returned the player's member club (terms: found).
-- @live-proof: md5(pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure)) = 'b1c21e14021e0e2e7bba28048dcec90e'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $migration$
DECLARE source text; patched text; edit record;
BEGIN
 source := pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure);
 IF md5(source) <> '552fe80a7fb04e1c76088a4c9de26eb5' THEN
  RAISE EXCEPTION 'fn_cash_earning_club preimage changed (expected 552fe80a7fb04e1c76088a4c9de26eb5, found %)', md5(source);
 END IF;
 patched := source;
 FOR edit IN SELECT * FROM (VALUES
  -- 1. Two locals for the funding evidence.
  (1, $a1$DECLARE started timestamptz;clubs uuid[];$a1$,
      $r1$DECLARE started timestamptz;clubs uuid[];chair uuid[];paid uuid[];$r1$),
  -- 2. The Lightning query also reads the anchor chair's club and its buy-in receipt.
  (2, $a2$  SELECT array_agg(DISTINCT cs.club_id) INTO clubs
$a2$, $r2$  -- The earning club is the club whose wallet funded the anchor chair, as
  -- for every Classic chair. cash_player_session.club_id is the TABLE's club,
  -- which on a union-hosted game is the union itself, not the funding club.
  SELECT array_agg(DISTINCT s.club_id) FILTER (WHERE s.club_id IS NOT NULL),
         array_agg(DISTINCT r.funding_club_id) FILTER (WHERE r.funding_club_id IS NOT NULL),
         array_agg(DISTINCT cs.club_id)
    INTO chair, paid, clubs
$r2$),
  (3, $a3$   JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id
$a3$, $r3$   JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
   LEFT JOIN public.table_seats s ON s.id=ps.anchor_seat_id AND s.user_id=hp.player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started)
   -- A chair row can be gone by settlement; its buy-in receipt is immutable.
   LEFT JOIN LATERAL (
    SELECT f.funding_club_id FROM public.cash_participant_funding_receipts f
     WHERE f.operation_kind='buyin' AND f.table_id=cs.table_id AND f.account_entity_id=hp.player_id
      AND f.user_id=hp.player_id AND f.seat_id=ps.anchor_seat_id
      AND f.seat_joined_at<=ps.entered_at AND f.recorded_at<=started
     ORDER BY f.seat_joined_at DESC, f.recorded_at DESC, f.id DESC LIMIT 1) r ON true
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id
$r3$),
  -- 3. Chair first, then (only when no chair) its receipt, each under the
  --    unchanged validation; otherwise the original session reader decides.
  (4, $a4$    AND (cs.closed_at IS NULL OR cs.closed_at>started);
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
$a4$, $r4$    AND (cs.closed_at IS NULL OR cs.closed_at>started);
  IF cardinality(chair)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=chair[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN chair[1]; END IF;
  IF chair IS NULL AND cardinality(paid)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=paid[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN paid[1]; END IF;
  -- No unambiguous funding chair: the original session reader, unchanged.
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
$r4$)
 ) v(n, anchor, replacement) ORDER BY n LOOP
  IF (length(patched) - length(replace(patched, edit.anchor, ''))) / length(edit.anchor) <> 1 THEN
   RAISE EXCEPTION 'fn_cash_earning_club anchor % is not unique', edit.n;
  END IF;
  patched := replace(patched, edit.anchor, edit.replacement);
 END LOOP;
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM patched THEN
  RAISE EXCEPTION 'fn_cash_earning_club readback mismatch';
 END IF;
 IF md5(patched) <> 'b1c21e14021e0e2e7bba28048dcec90e' THEN
  RAISE EXCEPTION 'fn_cash_earning_club postimage md5 mismatch (found %)', md5(patched);
 END IF;
END $migration$;
COMMIT;
