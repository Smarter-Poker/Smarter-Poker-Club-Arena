DROP TABLE IF EXISTS public.tournament_accounting_credit_receipts CASCADE;
CREATE TABLE public.tournament_accounting_credit_receipts(transaction_id xid8,
id uuid,
observed_at timestamp with time zone,
idempotency_key text,
tournament_id uuid,
user_id uuid,
asset text,
amount numeric,
ledger_id uuid,
wallet_transaction_id uuid,
payout_id uuid,
credited_club_id uuid,
ledger_snapshot jsonb,
wallet_snapshot jsonb,
payout_snapshot jsonb,
registration_snapshot jsonb,
tournament_snapshot jsonb,
entry_receipt_ids uuid[]);
DROP TABLE IF EXISTS public.tournament_participant_funding_receipts CASCADE;
CREATE TABLE public.tournament_participant_funding_receipts(id uuid,
transaction_id xid8,
observed_at timestamp with time zone,
registration_id uuid,
tournament_id uuid,
user_id uuid,
operation text,
purchase_key text,
asset text,
amount numeric,
entitlement_id uuid,
ledger_id uuid,
wallet_transaction_id uuid,
funding_club_id uuid,
registration_snapshot jsonb,
tournament_snapshot jsonb,
entitlement_snapshot jsonb,
ledger_snapshot jsonb,
wallet_snapshot jsonb,
custody_result jsonb);
DROP TABLE IF EXISTS public.tournament_refund_entitlements CASCADE;
CREATE TABLE public.tournament_refund_entitlements(id uuid,
tournament_id uuid,
user_id uuid,
entitlement_kind text,
charge_category text,
refund_wallet_club_id uuid,
gross numeric(15,2),
refund_prize numeric(15,2),
refund_bounty numeric(15,2),
refund_fee numeric(15,2),
source_ledger_id uuid,
registration_id uuid,
source_satellite_id uuid,
source_award_place integer,
source_ticket_id uuid,
escrow_bucket text,
evidence_kind text,
created_at timestamp with time zone);
DROP TABLE IF EXISTS public.tournament_refund_tranches CASCADE;
CREATE TABLE public.tournament_refund_tranches(wallet_transaction_id uuid,
idempotency_key text,
tournament_id uuid,
obligation_id uuid,
user_id uuid,
source_wallet_club_id uuid,
entitlement_id uuid,
credit_ledger_id uuid,
amount_paid_before numeric(15,2),
amount_paid_now numeric(15,2),
refund_prize numeric(15,2),
refund_bounty numeric(15,2),
refund_fee numeric(15,2),
source text,
description text,
created_at timestamp with time zone,
transaction_id xid8);
DROP TABLE IF EXISTS public.tournament_satellite_awards CASCADE;
CREATE TABLE public.tournament_satellite_awards(tournament_id uuid,
place integer,
user_id uuid,
delivery_kind text,
amount numeric(15,2),
payout_id uuid,
payout_source text,
idempotency_key text,
registration_id uuid,
ticket_id uuid,
obligation_id uuid,
obligation_kind text,
created_at timestamp with time zone);
DROP TABLE IF EXISTS public.tournament_satellite_settlements CASCADE;
CREATE TABLE public.tournament_satellite_settlements(tournament_id uuid,
target_id uuid,
target_was_missing boolean,
target_contract_version bigint,
winner_id uuid,
field_size integer,
advertised_seats integer,
pool numeric(15,2),
target_buy_in numeric(15,2),
target_fee numeric(15,2),
ticket_cost numeric(15,2),
ticket_award_count integer,
seat_count integer,
cash_ticket_count integer,
entry_ticket_count integer,
remainder numeric(15,2),
bubble_user_id uuid,
bubble_position integer,
source_table_count integer,
source_table_ids uuid[],
source_seat_count integer,
source_seat_ids uuid[],
released_seat_count integer,
released_seat_ids uuid[],
source_closed_at timestamp with time zone,
source_escrow_closed_at timestamp with time zone,
source_escrow_close_note text,
settled_at timestamp with time zone,
receipt_version integer,
qualifier_ids uuid[]);
DROP TABLE IF EXISTS public.tournament_tickets CASCADE;
CREATE TABLE public.tournament_tickets(id uuid,
club_id uuid,
issued_by uuid,
holder_id uuid,
value numeric,
note text,
status text,
redeemed_at timestamp with time zone,
cancelled_at timestamp with time zone,
created_at timestamp with time zone,
redemption_mode text,
source_tournament_id uuid,
source_satellite_id uuid,
source_refund_entitlement_id uuid,
source_satellite_award_place integer,
entry_prize numeric(15,2),
entry_bounty numeric(15,2),
entry_fee numeric(15,2));
DROP TABLE IF EXISTS public.union_pnl_opening_registration_resolutions CASCADE;
CREATE TABLE public.union_pnl_opening_registration_resolutions(boundary timestamp with time zone,
registration_id uuid,
tournament_id uuid,
user_id uuid,
union_id uuid,
registration_row_md5 text,
tournament_row_md5 text,
owning_club_id uuid,
asset text,
entries integer,
entry_amount numeric,
returned numeric,
deferred_amount numeric,
resolution_kind text,
proof jsonb,
proof_md5 text,
reason text,
resolved_by text,
resolved_at timestamp with time zone);
SET check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_satellite_seat_owner(p_registration_id uuid, p_tournament_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$;
 WITH reg AS (
  SELECT e.after_row r FROM public.union_pnl_inventory_events e
  WHERE e.source_name='tournament_players' AND e.row_id=p_registration_id ORDER BY e.event_id LIMIT 1
 ), who AS (
  SELECT (r->>'user_id')::uuid user_id,(r->>'source_satellite_id')::uuid satellite_id,(r->>'registered_at')::timestamptz registered_at,
   (r->>'tournament_id')::uuid target_id
  FROM reg WHERE (p_tournament_id IS NULL OR r->>'tournament_id'=p_tournament_id::text)
   AND r->>'source_satellite_id' IS NOT NULL AND r->>'user_id' IS NOT NULL AND r->>'tournament_id' IS NOT NULL
 ), award AS (
  SELECT a.tournament_id,a.user_id FROM who w
  JOIN public.tournament_satellite_awards a ON a.tournament_id=w.satellite_id AND a.user_id=w.user_id
  JOIN public.tournament_satellite_settlements s ON s.tournament_id=a.tournament_id AND s.target_id=w.target_id
  WHERE (a.delivery_kind='seat' AND a.registration_id=p_registration_id)
   OR (a.delivery_kind='ticket' AND a.registration_id IS NULL AND EXISTS(SELECT 1 FROM public.tournament_tickets t WHERE t.id=a.ticket_id
     AND t.holder_id=w.user_id AND t.source_satellite_id=w.satellite_id AND t.source_tournament_id=w.target_id
     AND t.status='redeemed' AND t.redemption_mode='tournament_entry_only' AND t.redeemed_at=w.registered_at))
 ), entry AS (
  SELECT count(*) n,count(DISTINCT r.funding_club_id) clubs,min(r.funding_club_id::text)::uuid club,
   count(*) FILTER(WHERE r.operation='entry') entries,
   count(*) FILTER(WHERE r.asset IS DISTINCT FROM 'chips' OR r.amount IS NULL OR r.amount<=0 OR r.funding_club_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.chip_ledger l WHERE l.id=r.ledger_id AND l.status='posted' AND l.from_type='player_wallet' AND l.from_entity_id=r.user_id
     AND l.to_type='prize_liability' AND l.to_entity_id=r.tournament_id AND l.tournament_id=r.tournament_id AND l.amount=r.amount
     AND l.club_id=r.funding_club_id AND l.category IN ('tournament_buyin','rebuy','addon') AND l.row_hash IS NOT NULL)) bad
  FROM award a JOIN public.tournament_participant_funding_receipts r ON r.tournament_id=a.tournament_id AND r.user_id=a.user_id
 )
 SELECT CASE WHEN (SELECT count(*) FROM award)=1 AND e.n>0 AND e.entries>=1 AND e.clubs=1 AND e.bad=0 THEN e.club END FROM entry e
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$;
  SELECT date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles'))
           AT TIME ZONE 'America/Los_Angeles';
$function$;

