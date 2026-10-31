-- Original seat occupancy supplies six previously unresolved paid BBJ owners.
-- A seat's club is the buy-in wallet, unlike cash_player_session.club_id (table host).
-- Never infer ownership from current membership, a later seat, or a union's host.
-- Snapshot all agreeing original seat witnesses before retention can remove them.
-- This changes reporting only. It never invokes a credit or edits financial rows.
-- Future awards already save their receiving club atomically (20261031044413).
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $capture$
DECLARE recipient uuid;
BEGIN
 FOR recipient IN
  WITH original AS (
   SELECT r.payout_id,r.user_id,r.game_variant,
     (array_agg(DISTINCT s.club_id))[1] AS club_id,
     'original_seat_occupancy:' || jsonb_agg(jsonb_build_object(
       'seat_id',s.id,'table_id',s.table_id,'club_id',s.club_id,
       'joined_at',s.joined_at,'left_at',s.left_at,
       'paid_at',r.created_at,'amount',r.amount) ORDER BY s.id)::text AS source
   FROM public.ca_paid_jackpot_reporting r
   JOIN public.bbj_payouts b ON b.id=r.payout_id
   JOIN public.table_seats s ON s.table_id=b.table_id AND s.user_id=r.user_id
    AND s.joined_at<=r.created_at AND (s.left_at IS NULL OR s.left_at>r.created_at)
   WHERE r.club_id IS NULL AND NOT r.display_only
   GROUP BY r.payout_id,r.user_id,r.game_variant
   HAVING count(DISTINCT s.club_id)=1 AND bool_and(s.club_id IS NOT NULL)
  ), saved AS (
   INSERT INTO public.bbj_recipient_reporting_owners(payout_id,user_id,club_id,game_variant,source)
   SELECT payout_id,user_id,club_id,game_variant,source FROM original
   ON CONFLICT(payout_id,user_id) DO NOTHING RETURNING user_id
  ) SELECT DISTINCT user_id FROM saved
 LOOP
  PERFORM public.fn_publish_member_record_user(recipient);
 END LOOP;
END $capture$;
COMMIT;
