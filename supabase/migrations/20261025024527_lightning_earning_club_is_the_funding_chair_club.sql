-- 20261025022551_lightning_earning_club_is_the_funding_chair_club.sql (PR #7983)
-- A Lightning hand earns for the club whose wallet funded the anchor chair
-- (as every Classic chair does), not the union host club. Rationale in the file.
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