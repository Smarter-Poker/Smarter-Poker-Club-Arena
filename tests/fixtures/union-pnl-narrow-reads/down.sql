-- Harness only: back to production's definitions (the migration's preimage).
DROP TRIGGER IF EXISTS union_pnl_inventory_touch ON public.union_pnl_inventory_events;
DROP TRIGGER IF EXISTS union_pnl_cash_outcome_touch ON public.union_pnl_cash_outcomes;
DROP TRIGGER IF EXISTS union_pnl_credit_touch ON public.tournament_accounting_credit_receipts;
DROP PROCEDURE IF EXISTS public.sp_union_pnl_projection_build(integer,integer,integer,integer);
DROP TABLE IF EXISTS public.union_pnl_inventory_touches, public.union_pnl_cash_outcome_touches, public.union_pnl_credit_touches,
 public.union_pnl_projection_build CASCADE;
DROP FUNCTION IF EXISTS public.fn_union_pnl_compact_participants(jsonb), public.fn_union_pnl_inventory_touch(), public.fn_union_pnl_cash_outcome_touch(),
 public.fn_union_pnl_credit_touch(), public.fn_union_pnl_projection_build_guard(), public.fn_union_pnl_projection_ready(text),
 public.fn_union_pnl_projection_build_step(text,integer), public.fn_union_pnl_projection_build_pending(), public.fn_union_pnl_projection_status(),
 public.fn_union_pnl_projection_verify(real), public.fn_union_pnl_touched_registrations(timestamptz,timestamptz,boolean),
 public.fn_union_pnl_tournament_in_union(text,uuid,boolean), public.fn_union_pnl_first_inventory_operation(text,uuid,boolean),
 public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean), public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean), public.fn_union_pnl_week_union_credits(uuid,timestamptz,timestamptz,boolean),
 public.fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb);
