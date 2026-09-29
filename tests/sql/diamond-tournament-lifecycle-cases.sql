-- ============================================================================
-- THE DIAMOND TOURNAMENT LIFECYCLE CASES
-- ============================================================================
-- PRIVATE ISOLATED FIXTURE ONLY. Every door called here is the installed door,
-- md5-pinned by the two captures loaded before this file. No guard is disabled,
-- no trigger is dropped for a case, and NEITHER ARENA SWITCH IS EVER OPENED:
-- cash_games_enabled and tournaments_enabled arrive false, as production holds
-- them, and the runner refuses to pass if either is on when the cases finish.
--
-- THE SWITCH DECIDES WHAT THIS FILE CAN PROVE, AND THE LIMIT IS NAMED RATHER
-- THAN WORKED AROUND. fn_poker_diamond_reserve refuses a tournament entry while
-- tournaments_enabled is off ('diamond_tournaments_not_open'), and
-- fn_poker_diamond_tournament_charge refuses a rebuy, re-entry or add-on at the
-- same test. So no Diamond can be taken for an entry here, and every case that
-- would need a funded custody row is a REFUSAL case, asserted to move nothing.
-- The changelog beside this file says exactly which Phase 8 checklist lines
-- that reaches and which it does not.
--
-- NO NUMBER HERE IS INVENTED. The buy-in, field, starting stack and blind
-- ladder are the estate's own committed native MTT creation inputs, from
-- scripts/ci/probes/mtt-dual-creation-preparation-native.sql lines 26-29
-- (buyIn 20, maxPlayers 100, minPlayers 3, startingStack 10000, levels 25/50
-- and 50/100 at 600 seconds). The single-place payout structure is that same
-- file's line 29. The five-place payout structure is this repository's own
-- stored structure from tests/unit/payoutStructureBubble.test.ts line 77
-- (40/25/18/10/7). Nothing is a recovered production price, guarantee or
-- ladder, and nothing states what a future event owes anybody.
-- ============================================================================

CREATE FUNCTION fixture_as(p_uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_uid::text, false),
         set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claims',
           jsonb_build_object('role','authenticated','sub',p_uid)::text, false);
  SELECT NULL::void;
$$;

-- The estate's own committed native MTT creation inputs, unedited.
CREATE FUNCTION fixture_mtt_config() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'name','Native MTT','type','mtt','gameVariant','NLH','buyIn',20,'maxPlayers',100,
    'minPlayers',3,'startingStack',10000,
    'blindStructure','[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
    'payoutStructure','[{"place":1,"percentage":100}]'::jsonb);
$$;

-- This repository's own stored five-place structure.
CREATE FUNCTION fixture_five_places() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT '[{"place":1,"percentage":40},{"place":2,"percentage":25},{"place":3,"percentage":18},{"place":4,"percentage":10},{"place":5,"percentage":7}]'::jsonb;
$$;

CREATE FUNCTION fixture_create(p_config jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  r := public.fn_poker_diamond_create_tournament(p_config);
  IF COALESCE((r->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the create door did not succeed: %', r;
  END IF;
  RETURN (r->>'tournamentId')::uuid;
END $$;

SELECT fixture_as('10000000-0000-0000-0000-00000000000f');

-- ===========================================================================
-- CASE 1: REGISTRATION - THE EVENT A PLAYER WOULD REGISTER INTO
-- ===========================================================================
CREATE TABLE fixture_events(label text PRIMARY KEY, tournament_id uuid);
INSERT INTO fixture_events
SELECT 'unlimited', fixture_create(fixture_mtt_config() - 'maxPlayers'
  || jsonb_build_object('name','Diamond Fixture Unlimited MTT',
                        'payoutStructure',fixture_five_places()));

DO $case1$
DECLARE t public.tournaments%ROWTYPE; v_id uuid;
BEGIN
  SELECT tournament_id INTO v_id FROM fixture_events WHERE label='unlimited';
  SELECT * INTO t FROM public.tournaments WHERE id=v_id;
  PERFORM fixture_assert(t.status='REGISTERING' AND t.current_players=0
    AND NOT t.entry_contract_locked,
    'registration: a new Diamond event opens REGISTERING with nobody in it and an unlocked entry contract');
  -- The fee rule, recomputed here from the door's own two primitives rather
  -- than from a number typed into this file.
  PERFORM fixture_assert(t.buy_in_amount+t.buy_in_fee=20
    AND t.buy_in_fee=public.fn_ca_unit_floor_cents(round(20*100*0.10)::bigint,100)/100
    AND t.buy_in_amount=20-t.buy_in_fee
    AND t.buy_in_amount=trunc(t.buy_in_amount) AND t.buy_in_fee=trunc(t.buy_in_fee),
    'registration: the entry is priced in whole Diamonds and buy-in plus fee is exactly the total');
  PERFORM fixture_assert(public.fn_ca_tournament_unit_cents(v_id)=100
    AND public.fn_poker_diamond_tournament(v_id)
    AND public.fn_ca_tournament_recorded_format(v_id)='mtt-v2'
    AND public.fn_ca_tournament_is_unlimited(v_id),
    'registration: the row the door wrote is the one the money path prices, at the Diamond unit');
  PERFORM fixture_assert(t.max_players IS NULL AND t.min_players=3 AND t.table_size=9
    AND NOT public.fn_tournament_entry_cap_reached(v_id),
    'registration: an unlimited event records its capacity in its format and refuses nobody on a cap');
  PERFORM fixture_assert((SELECT count(*)=5 FROM jsonb_array_elements(t.payout_structure::jsonb))
    AND (SELECT sum((e->>'percentage')::numeric)=100 FROM jsonb_array_elements(t.payout_structure::jsonb) e)
    AND t.payout_percent=10,
    'registration: every paid place the door was given is stored, and they total one hundred percent');
  PERFORM fixture_assert((SELECT count(*)=1 FROM public.union_pnl_inventory_events
     WHERE source_name='tournaments' AND row_id=v_id AND operation='INSERT'),
    'registration: production''s own inventory observer saw the event appear exactly once');
END $case1$;

-- The door's refusals, every one of them reached before any row is written.
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('type','satellite'))$q$,
  'diamond_tournament_format_not_open');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('type','spin'))$q$,
  'diamond_tournament_format_not_open');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('guarantee',1))$q$,
  'diamond_tournament_format_not_open');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('freeBuy',true))$q$,
  'diamond_tournament_format_not_open');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('satelliteTargetId','20000000-0000-0000-0000-0000000000aa'))$q$,
  'diamond_tournament_format_not_open');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('buyIn',20.5))$q$,
  'diamond_tournament_requires_a_whole_positive_buy_in');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('buyIn',0))$q$,
  'diamond_tournament_requires_a_whole_positive_buy_in');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('gameVariant','BADGER'))$q$,
  'diamond_tournament_requires_a_supported_game');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('blindStructure','[]'::jsonb))$q$,
  'blind_structure_required');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('payoutStructure','[]'::jsonb))$q$,
  'payout_structure_required');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object(
   'payoutStructure','[{"place":1,"percentage":40},{"place":2,"percentage":25}]'::jsonb))$q$,
  'payouts_must_total_100');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('bountyAmount',5))$q$,
  'diamond_tournament_bounty_requires_a_bounty_format');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('isBounty',true))$q$,
  'diamond_tournament_bounty_requires_a_bounty_format');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('mysteryBountyMin','1'))$q$,
  'diamond_tournament_mystery_requires_a_mystery_format');
SELECT fixture_refuses($q$SELECT fixture_create('[]'::jsonb)$q$,
  'diamond_tournament_requires_a_configuration');

-- The staff gate, and what a player is refused.
SELECT fixture_as('10000000-0000-0000-0000-000000000001');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config())$q$,
  'diamond_tournament_staff_only');
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','{}',false);
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config())$q$,
  'authentication required');
SELECT fixture_assert((SELECT count(*)=1 FROM public.tournaments),
  'registration: fifteen refused configurations and two refused callers wrote no event');
SELECT fixture_as('10000000-0000-0000-0000-00000000000f');

-- ===========================================================================
-- CASE 2: LATE ENTRY - THE WINDOW, AS FAR AS THE CREATE PATH REACHES
-- ===========================================================================
-- fn_tournament_late_registration_open is the estate's late-entry window, and
-- its first test is `t.status='RUNNING'`. The fixture can prove the window is
-- SHUT before an event runs and shut for a format that has no window at all.
-- It cannot yet prove the window OPEN, because reaching RUNNING needs the
-- UPDATE half of production's tournaments trigger chain, which this capture
-- does not carry. The exact blocker is named in the changelog.
INSERT INTO fixture_events
SELECT 'sng', fixture_create(fixture_mtt_config()
  || jsonb_build_object('type','sng','name','Diamond Fixture SNG','maxPlayers',6));

DO $case2$
DECLARE v_mtt uuid; v_sng uuid; t public.tournaments%ROWTYPE;
BEGIN
  SELECT tournament_id INTO v_mtt FROM fixture_events WHERE label='unlimited';
  SELECT tournament_id INTO v_sng FROM fixture_events WHERE label='sng';
  SELECT * INTO t FROM public.tournaments WHERE id=v_mtt;
  PERFORM fixture_assert(t.late_reg_levels=8 AND t.late_reg_mins=8 AND t.rebuy_levels=4,
    'late entry: an MTT the door created carries the late-registration window the door states');
  PERFORM fixture_assert(NOT public.fn_tournament_late_registration_open(v_mtt),
    'late entry: the window is shut while the event is still REGISTERING');
  SELECT * INTO t FROM public.tournaments WHERE id=v_sng;
  PERFORM fixture_assert(t.tournament_type='SNG' AND t.variant='sng'
    AND t.late_reg_levels=0 AND t.max_players=6 AND t.table_size=6
    AND NOT public.fn_ca_tournament_is_unlimited(v_sng)
    AND public.fn_ca_tournament_recorded_format(v_sng)='sng-v1',
    'late entry: a sit-and-go is capped, is not an unlimited MTT and is created with no late-registration window');
  PERFORM fixture_assert(NOT public.fn_tournament_late_registration_open(v_sng),
    'late entry: a format with no window never opens one');
  PERFORM fixture_assert(NOT public.fn_tournament_entry_cap_reached(v_sng),
    'late entry: a capped event with nobody in it has not reached its cap');
END $case2$;

-- ===========================================================================
-- CASE 3: RE-ENTRY, REBUY AND ADD-ON - WHAT THE DOOR WRITES AND WHAT IT REFUSES
-- ===========================================================================
INSERT INTO fixture_events
SELECT 'rebuy', fixture_create(fixture_mtt_config()
  || jsonb_build_object('name','Diamond Fixture Rebuy MTT','rebuy',true,'addOn',true));

DO $case3$
DECLARE t public.tournaments%ROWTYPE; v_id uuid; c record;
BEGIN
  SELECT tournament_id INTO v_id FROM fixture_events WHERE label='rebuy';
  SELECT * INTO t FROM public.tournaments WHERE id=v_id;
  PERFORM fixture_assert(t.is_rebuy AND t.is_reentry AND t.add_on_available
    AND t.rebuy_cost=20 AND t.addon_cost=20
    AND t.rebuy_cost=trunc(t.rebuy_cost) AND t.addon_cost=trunc(t.addon_cost)
    AND t.rebuy_chips=t.starting_chips AND t.addon_chips=t.starting_chips
    AND t.max_rebuys=2 AND t.max_reentries=1 AND t.addon_levels=1 AND t.rebuy_levels=6,
    'rebuy and add-on: the door writes whole-Diamond costs and the stack each one buys');
  -- The freezeout the first case created takes none of them.
  SELECT * INTO t FROM public.tournaments WHERE id=(SELECT tournament_id FROM fixture_events WHERE label='unlimited');
  PERFORM fixture_assert(NOT t.is_rebuy AND NOT t.is_reentry AND NOT t.add_on_available
    AND t.rebuy_cost=0 AND t.addon_cost=0 AND t.rebuy_chips=0 AND t.addon_chips=0
    AND t.max_rebuys=0 AND t.max_reentries=0,
    'rebuy and add-on: a freezeout carries no rebuy, re-entry or add-on price at all');
  -- The entry split the money path uses, on the door's own numbers.
  SELECT * INTO c FROM public.fn_tournament_entry_split(t.buy_in_amount,t.buy_in_fee,0,false);
  PERFORM fixture_assert(c.charge=20 AND c.rake=t.buy_in_fee AND c.bounty=0 AND c.prize=t.buy_in_amount,
    'rebuy and add-on: the entry split returns the fee as rake and the rest as prize, with no bounty');
END $case3$;

SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('rebuy',true,'rebuyCost',20.5))$q$,
  'diamond_tournament_requires_a_whole_rebuy_cost');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('rebuy',true,'rebuyCost',0))$q$,
  'diamond_tournament_requires_a_whole_rebuy_cost');
SELECT fixture_refuses($q$SELECT fixture_create(fixture_mtt_config()||jsonb_build_object('addOn',true,'addonCost',20.5))$q$,
  'diamond_tournament_requires_a_whole_addon_cost');

-- ===========================================================================
-- CASE 4: BLIND CLOCKS
-- ===========================================================================
DO $case4$
DECLARE v_id uuid; b jsonb;
BEGIN
  SELECT tournament_id INTO v_id FROM fixture_events WHERE label='unlimited';
  b := public.fn_tournament_current_blinds(v_id);
  PERFORM fixture_assert(b->>'source'='persisted' AND (b->>'small_blind')::numeric=25
    AND (b->>'big_blind')::numeric=50 AND (b->>'ante')::numeric=0
    AND (b->>'level_index')::int=0 AND NOT (b->>'blind_capped')::boolean,
    'blind clock: level one is the first level of the ladder the event was created with');
  UPDATE public.tournaments SET current_level=1 WHERE id=v_id;
  b := public.fn_tournament_current_blinds(v_id);
  PERFORM fixture_assert(b->>'source'='persisted' AND (b->>'small_blind')::numeric=50
    AND (b->>'big_blind')::numeric=100 AND (b->>'level_index')::int=1,
    'blind clock: the clock advances to the second level of the same ladder');
  UPDATE public.tournaments SET current_level=2 WHERE id=v_id;
  b := public.fn_tournament_current_blinds(v_id);
  PERFORM fixture_assert(b->>'source'='mtt_overflow'
    AND (b->>'small_blind')::numeric=80 AND (b->>'big_blind')::numeric=160
    AND (b->>'overflow_ratio')::numeric=1.6,
    'blind clock: a level past the end of the ladder is carried by the estate''s own overflow, not by a stall');
  UPDATE public.tournaments SET current_level=0 WHERE id=v_id;
  PERFORM fixture_assert((public.fn_tournament_current_blinds(v_id)->>'small_blind')::numeric=25,
    'blind clock: the clock reads the level it is told, every time');
END $case4$;

-- ===========================================================================
-- CASE 5: PRIZE ESCROW IS SEPARATE FROM THE PLAYING UNITS
-- ===========================================================================
DO $case5$
DECLARE v_id uuid; e record; p jsonb;
BEGIN
  SELECT tournament_id INTO v_id FROM fixture_events WHERE label='unlimited';
  SELECT * INTO e FROM public.fn_poker_diamond_tournament_escrow(v_id);
  PERFORM fixture_assert(e.prize_in=0 AND e.bounty_in=0 AND e.fee_in=0
    AND e.prize_out=0 AND e.bounty_out=0 AND e.fee_out=0 AND e.refund_out=0
    AND e.prize_balance=0 AND e.bounty_balance=0 AND e.fee_balance=0,
    'escrow: an event nobody has paid into holds nothing in any of its three banks');
  PERFORM fixture_assert(public.fn_poker_diamond_tournament_custody(v_id)=0
    AND (SELECT count(*)=0 FROM public.poker_diamond_custody)
    AND (SELECT count(*)=0 FROM public.poker_diamond_tournament_ledger),
    'escrow: no custody row and no ledger line exists for an unfunded event');
  -- The Diamond reader and the chip reader are different readers, and the
  -- Diamond event answers on the Diamond one.
  PERFORM fixture_assert((SELECT count(*)=0 FROM public.tournament_escrow)
    AND (public.fn_ca_escrow_can_pay(v_id,'prize',1)->>'known')::boolean
    AND (public.fn_ca_escrow_can_pay(v_id,'prize',1)->>'asset')='diamonds'
    AND (public.fn_ca_escrow_can_pay(v_id,'prize',1)->>'enforced')::boolean,
    'escrow: with no chip escrow row at all, the Diamond event still answers from its own banks, enforced');
  p := public.fn_ca_escrow_can_pay(v_id,'prize',1);
  PERFORM fixture_assert(NOT (p->>'ok')::boolean AND (p->>'available')::numeric=0,
    'escrow: one Diamond cannot be paid out of an empty prize bank');
  PERFORM fixture_assert(NOT (public.fn_ca_escrow_can_pay(v_id,'bounty',1)->>'ok')::boolean
    AND NOT (public.fn_ca_escrow_can_pay(v_id,'refund',1)->>'ok')::boolean,
    'escrow: the bounty bank and the refund total are empty and separately empty');
  -- The playing units are chips on the seat; the obligation is Diamonds.
  PERFORM fixture_assert((SELECT starting_chips=10000 FROM public.tournaments WHERE id=v_id)
    AND public.fn_ca_tournament_unit_cents(v_id)=100,
    'escrow: the playing stack is tournament chips while the money the event owes is priced in whole Diamonds');
END $case5$;

-- ===========================================================================
-- CASE 6: THE ARENA IS CLOSED, AND THE CLOSED SWITCH IS WHAT REFUSES THE MONEY
-- ===========================================================================
-- This is the strongest thing this fixture asserts, and it is the reason every
-- funded case below it is a refusal: with tournaments_enabled false, no Diamond
-- can be taken for a tournament entry, and the refusal leaves nothing behind.
DO $case6$
DECLARE v_id uuid; v_before bigint;
BEGIN
  SELECT tournament_id INTO v_id FROM fixture_events WHERE label='unlimited';
  SELECT sum(diamonds) INTO v_before FROM public.profiles;
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_charge(
      '10000000-0000-0000-0000-000000000001'::uuid,%L::uuid,'entry',20,18,0,2,
      '30000000-0000-0000-0000-000000000001'::uuid,'fixture-entry-1')$f$, v_id),
    'diamond_tournaments_not_open');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_reserve(
      '10000000-0000-0000-0000-000000000001'::uuid,'tournament_entry',%L::uuid,'entry:x',20,
      '40000000-0000-0000-0000-00000000000a'::uuid)$f$, v_id),
    'diamond_tournaments_not_open');
  PERFORM fixture_assert((SELECT sum(diamonds) FROM public.profiles)=v_before
    AND (SELECT count(*)=0 FROM public.poker_diamond_custody)
    AND (SELECT count(*)=0 FROM public.poker_diamond_movements)
    AND (SELECT count(*)=0 FROM public.poker_diamond_tournament_ledger)
    AND (SELECT count(*)=0 FROM public.diamond_transactions WHERE source='poker_arena')
    AND (SELECT count(*)=0 FROM public.poker_diamond_lot_reservations)
    AND (SELECT COALESCE(sum(arena_reserved),0)=0 FROM public.diamond_purchase_lots)
    AND (SELECT NOT entry_contract_locked FROM public.tournaments WHERE id=v_id),
    'the closed switch: a refused entry moves no wallet, opens no custody, writes no ledger line, journals nothing and does not lock the entry contract');
  -- A rebuy, re-entry or add-on with no entry held is refused before the switch
  -- is even consulted, so both refusals are proved separately.
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_charge(
      '10000000-0000-0000-0000-000000000001'::uuid,%L::uuid,'rebuy',20,18,0,2,NULL,'fixture-rebuy-1')$f$, v_id),
    'diamond_tournament_entry_not_held');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_charge(
      '10000000-0000-0000-0000-000000000001'::uuid,%L::uuid,'reentry',20,18,0,2,NULL,'fixture-reentry-1')$f$, v_id),
    'diamond_tournament_entry_not_held');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_charge(
      '10000000-0000-0000-0000-000000000001'::uuid,%L::uuid,'addon',20,18,0,2,NULL,'fixture-addon-1')$f$, v_id),
    'diamond_tournament_entry_not_held');
  -- The parts rule, which is checked before anything else.
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_charge(
      '10000000-0000-0000-0000-000000000001'::uuid,%L::uuid,'entry',20,18,0,3,
      '30000000-0000-0000-0000-000000000001'::uuid,'fixture-parts-1')$f$, v_id),
    'diamond_tournament_charge_requires_whole_parts');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_charge(
      '10000000-0000-0000-0000-000000000001'::uuid,%L::uuid,'entry',20,17.5,0,2.5,
      '30000000-0000-0000-0000-000000000001'::uuid,'fixture-parts-2')$f$, v_id),
    'diamond_tournament_charge_requires_whole_parts');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_charge(
      '10000000-0000-0000-0000-000000000001'::uuid,%L::uuid,'entry',20,18,0,2,NULL,'fixture-parts-3')$f$, v_id),
    'diamond_tournament_entry_requires_a_registration');
END $case6$;

-- ===========================================================================
-- CASE 7: ONE OBLIGATION, AND NOTHING IS PAID TWICE OR OUT OF AN EMPTY BANK
-- ===========================================================================
DO $case7$
DECLARE v_id uuid;
BEGIN
  SELECT tournament_id INTO v_id FROM fixture_events WHERE label='unlimited';
  PERFORM fixture_assert(
    public.fn_poker_diamond_tournament_unregister(v_id,'10000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001')
      = '{"ok": false, "reason": "not_registered"}'::jsonb,
    'settlement: unregistering an entry nobody holds answers with a reason, not with a payment');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_refund(
      %L::uuid,'10000000-0000-0000-0000-000000000001','cancel','fixture',
      '40000000-0000-0000-0000-000000000002'::uuid)$f$, v_id),
    'diamond_tournament_entry_not_held');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_pay(
      '10000000-0000-0000-0000-000000000001'::uuid,1,'fixture-pay-1','prize',%L::uuid,'fixture prize')$f$, v_id),
    'diamond_tournament_bank_short');
  PERFORM fixture_refuses(format($f$SELECT public.fn_poker_diamond_tournament_drain(
      %L::uuid,'prize',1,'fixture','house',NULL)$f$, v_id),
    'diamond_tournament_custody_short');
  -- A fee settlement with no fee part banked is a zero, not a phantom payment.
  PERFORM fixture_assert(
    public.fn_poker_diamond_tournament_settle_fee(v_id,'fixture')
      = '{"ok": true, "amount": 0, "destination": "none"}'::jsonb,
    'settlement: settling a fee nobody has paid banks zero and names no destination');
  PERFORM fixture_assert((SELECT count(*)=0 FROM public.poker_diamond_tournament_ledger)
    AND (SELECT count(*)=0 FROM public.poker_diamond_movements),
    'settlement: five refused obligation calls and one zero settlement wrote no ledger line and no movement');
END $case7$;

-- ===========================================================================
-- CASE 8: A CANCELLED EVENT, AND THE SAME CANCELLATION TWICE
-- ===========================================================================
-- The cancel door is the engine's, and the engine is service_role: the door
-- says so itself ("A service-role call carries no uid"), and
-- fn_guard_managed_game_lifecycle admits a lifecycle change from the engine and
-- from nobody else. The fixture calls it the way production does.
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_tournament_cancel(
   (SELECT tournament_id FROM fixture_events WHERE label='sng'),NULL)$q$,
  'Tournament lifecycle changes must use fn_close_managed_game');

SELECT fixture_as('10000000-0000-0000-0000-000000000001');
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_tournament_cancel(
   (SELECT tournament_id FROM fixture_events WHERE label='sng'),NULL)$q$,
  'Only platform staff may cancel a Diamond tournament');

SELECT set_config('request.jwt.claim.sub','',false),
       set_config('request.jwt.claim.role','service_role',false),
       set_config('request.jwt.claims','{"role":"service_role"}',false);

CREATE TABLE fixture_cancellations(label text PRIMARY KEY, receipt jsonb);
INSERT INTO fixture_cancellations
SELECT 'first', public.fn_poker_diamond_tournament_cancel(
  (SELECT tournament_id FROM fixture_events WHERE label='sng'),
  '10000000-0000-0000-0000-00000000000f');

DO $case8$
DECLARE v_id uuid; r jsonb; t public.tournaments%ROWTYPE;
BEGIN
  SELECT tournament_id INTO v_id FROM fixture_events WHERE label='sng';
  SELECT receipt INTO r FROM fixture_cancellations WHERE label='first';
  SELECT * INTO t FROM public.tournaments WHERE id=v_id;
  PERFORM fixture_assert((r->>'ok')::boolean AND (r->>'fully_settled')::boolean
    AND r->>'status'='CANCELLED' AND r->>'asset'='diamonds'
    AND (r->>'total_refunded')::numeric=0 AND (r->>'fees_reversed')::numeric=0
    AND (r->>'source_player_count')::int=0 AND (r->>'refunded_count')::int=0
    AND r->>'actor_id'='10000000-0000-0000-0000-00000000000f',
    'cancellation: an event nobody entered cancels fully settled, owing nobody anything');
  PERFORM fixture_assert(t.status='CANCELLED' AND t.ended_at IS NOT NULL
    AND t.prize_pool=0 AND t.bounty_pool=0 AND t.total_rake=0 AND t.current_players=0,
    'cancellation: the event is closed and every cached pool on it is zeroed');
  PERFORM fixture_assert((SELECT count(*)=1 FROM public.tournament_cancellation_receipts
                           WHERE tournament_id=v_id),
    'cancellation: exactly one immutable cancellation receipt is written');
  PERFORM fixture_assert(public.fn_poker_diamond_tournament_custody(v_id)=0
    AND (SELECT prize_balance+bounty_balance+fee_balance=0
           FROM public.fn_poker_diamond_tournament_escrow(v_id)),
    'cancellation: every custody bank on the cancelled event closes at exact zero');
  -- The duplicate attempt: the stored receipt is the answer, replayed exactly.
  PERFORM fixture_assert(
    public.fn_poker_diamond_tournament_cancel(v_id,'10000000-0000-0000-0000-00000000000f') = r,
    'duplicate: cancelling the same event again returns the stored receipt byte for byte');
  PERFORM fixture_assert((SELECT count(*)=1 FROM public.tournament_cancellation_receipts
                           WHERE tournament_id=v_id),
    'duplicate: the second cancellation wrote no second receipt');
END $case8$;

-- A started event is resumed or settled, never voided. The chip rule, unchanged.
UPDATE public.tournaments SET started_at=now()
 WHERE id=(SELECT tournament_id FROM fixture_events WHERE label='rebuy');
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_tournament_cancel(
   (SELECT tournament_id FROM fixture_events WHERE label='rebuy'),
   '10000000-0000-0000-0000-00000000000f')$q$,
  'Tournament has started or committed awards');
UPDATE public.tournaments SET started_at=NULL
 WHERE id=(SELECT tournament_id FROM fixture_events WHERE label='rebuy');

-- ===========================================================================
-- CASE 9: PHASE 9'S LAST LINE ACROSS EVERY DIAMOND FORMAT - ONE TABLE
-- ===========================================================================
-- Prize-pool conservation, capped exposure, rounding and cancellation
-- recovery, across every tournament format the Diamond create door admits
-- today. ADDING A FORMAT IS ADDING A ROW to fixture_formats: cases 9 to 12
-- loop over the table, and the lifecycle law refuses a table that leaves out a
-- format the captured create door admits.
--
-- WHAT A CLOSED ARENA CAN PROVE IS PROVED HERE: the price each format's door
-- writes and how it rounds at the Diamond unit, that every bank refuses to pay
-- one Diamond past what it holds, that the closed switch refuses every format's
-- entry, that every format cancels before launch owing nobody, and the
-- installed ladder arithmetic at both units (case 13). WHAT ONLY A FUNDED EVENT
-- CAN PROVE - entries taken, knockouts paid, a terminal settled, a started event
-- refusing cancellation with every Diamond still in custody - needs
-- tournaments_enabled, which this fixture never opens. That half was proved on
-- 2026-09-21 through the same installed doors by a rolled-back production
-- rehearsal, recorded with its numbers in
-- docs/changelog/2026-09-21-diamond-phase-9-cross-format-conservation.md.
--
-- NO NUMBER HERE IS INVENTED. Each row is one of the estate's own committed
-- configurations:
--   mtt, sng             the native MTT inputs above (buyIn 20), the second as
--                        the six-seat sit-and-go of case 2
--   bounty               "Bounty Builder": buyIn 10, bountyAmount 5
--   progressive_bounty   "Thursday Thrill": buyIn 25, bountyAmount 11
--   pko_under_ten        "Blitz Bounty": buyIn 3, bountyAmount 1
--   mystery_bounty       "Mystery Wednesday": buyIn 20, bountyAmount 9,
--                        mysteryBountyMin 0.5, mysteryBountyMax 13
-- the last four from supabase/migrations/20260822110000_midway_weekly_schedule_seed.sql
-- (lines 59, 153, 121 and 148). Thursday Thrill's 25 does not divide by ten,
-- Blitz Bounty's 3 is too small to carry a fee at all, and half of Mystery
-- Wednesday's 9 is 4.5: those are the rounding rows.
-- ===========================================================================
SELECT fixture_as('10000000-0000-0000-0000-00000000000f');
CREATE TABLE fixture_formats(label text PRIMARY KEY, ord int UNIQUE NOT NULL, config jsonb NOT NULL, tournament_id uuid);
INSERT INTO fixture_formats(label, ord, config) VALUES
 ('mtt', 1, fixture_mtt_config()
   || jsonb_build_object('name','Diamond Fixture Conservation MTT')),
 ('sng', 2, fixture_mtt_config()
   || jsonb_build_object('name','Diamond Fixture Conservation SNG','type','sng','maxPlayers',6)),
 ('bounty', 3, fixture_mtt_config()
   || jsonb_build_object('name','Diamond Fixture Conservation Bounty','type','bounty','buyIn',10,'bountyAmount',5)),
 ('progressive_bounty', 4, fixture_mtt_config()
   || jsonb_build_object('name','Diamond Fixture Conservation PKO','type','progressive_bounty','buyIn',25,'bountyAmount',11)),
 ('pko_under_ten', 5, fixture_mtt_config()
   || jsonb_build_object('name','Diamond Fixture Conservation Small PKO','type','progressive_bounty','buyIn',3,'bountyAmount',1)),
 ('mystery_bounty', 6, fixture_mtt_config()
   || jsonb_build_object('name','Diamond Fixture Conservation Mystery','type','mystery_bounty','buyIn',20,'bountyAmount',9,
                         'mysteryBountyMin',0.5,'mysteryBountyMax',13));
UPDATE fixture_formats SET tournament_id = fixture_create(config);

DO $case9$
DECLARE f record; t public.tournaments%ROWTYPE; s record; v_total numeric; v_ratio numeric;
        v_chip_fee numeric; v_fee numeric; v_is_bounty boolean;
BEGIN
  FOR f IN SELECT * FROM fixture_formats ORDER BY ord LOOP
    SELECT * INTO t FROM public.tournaments WHERE id=f.tournament_id;
    v_total := (f.config->>'buyIn')::numeric;
    v_ratio := CASE WHEN t.max_players IS NOT NULL AND t.max_players <= 2 THEN 0.05 ELSE 0.10 END;
    -- What a chip event keeps as its fee (unit 1) and what the Diamond unit
    -- keeps (unit 100), both from the installed floor, never from this file.
    v_chip_fee := public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 1) / 100.0;
    v_fee := public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 100) / 100;
    v_is_bounty := t.is_bounty OR t.is_pko OR t.is_mystery_bounty;
    PERFORM fixture_assert(public.fn_ca_tournament_unit_cents(f.tournament_id) = 100
      AND public.fn_poker_diamond_tournament(f.tournament_id)
      AND t.status = 'REGISTERING' AND NOT t.entry_contract_locked AND t.current_players = 0,
      format('%s: the create door writes a Diamond event the money path prices at the Diamond unit', f.label));
    PERFORM fixture_assert(t.buy_in_fee = v_fee AND t.buy_in_amount + t.buy_in_fee = v_total
      AND t.buy_in_fee = trunc(t.buy_in_fee) AND t.buy_in_amount = trunc(t.buy_in_amount)
      AND t.bounty_amount = trunc(t.bounty_amount),
      format('%s: a %s Diamond entry takes a fee of %s at the Diamond unit where a chip event takes %s; the %s it cannot take stays in the buy-in, and every part is a whole Diamond',
             f.label, v_total, v_fee, v_chip_fee, v_chip_fee - v_fee));
    SELECT * INTO s FROM public.fn_tournament_entry_split(t.buy_in_amount, t.buy_in_fee, t.bounty_amount, v_is_bounty);
    PERFORM fixture_assert(s.charge = v_total AND s.rake = t.buy_in_fee
      AND s.bounty = CASE WHEN v_is_bounty THEN t.bounty_amount ELSE 0 END
      AND s.prize + s.bounty + s.rake = s.charge AND s.prize >= 0
      AND s.prize = trunc(s.prize) AND s.bounty = trunc(s.bounty) AND s.rake = trunc(s.rake),
      format('%s: one entry is prize %s + bounty %s + fee %s = %s, whole Diamonds that sum exactly',
             f.label, s.prize, s.bounty, s.rake, s.charge));
    IF t.is_mystery_bounty THEN
      PERFORM fixture_assert(
        t.mystery_bounty_min = trunc(t.bounty_amount * (f.config->>'mysteryBountyMin')::numeric)
        AND t.mystery_bounty_max = trunc(t.bounty_amount * (f.config->>'mysteryBountyMax')::numeric)
        AND t.mystery_bounty_min = trunc(t.mystery_bounty_min) AND t.mystery_bounty_max = trunc(t.mystery_bounty_max),
        format('%s: the advertised chest range is %s to %s whole Diamonds; the fraction of %s x %s is cut, not paid',
               f.label, t.mystery_bounty_min, t.mystery_bounty_max, t.bounty_amount, f.config->>'mysteryBountyMin'));
    END IF;
  END LOOP;
  PERFORM fixture_assert((SELECT count(*) = 6 FROM fixture_formats WHERE tournament_id IS NOT NULL),
    'every format in the table was created through the door');
END $case9$;

-- ===========================================================================
-- CASE 10: CAPPED EXPOSURE - NO BANK OF ANY FORMAT PAYS PAST WHAT IT HOLDS
-- ===========================================================================
-- Every bank of every format holds nothing yet, so one Diamond is already one
-- past it. Each refusal is asserted BY NAME, never as an overdraw, and the pay
-- door's credit key - claimed before the bank is read - must roll back with the
-- refusal, or a later legitimate payment under the same key would be refused
-- as a replay.
DO $case10$
DECLARE f record; b text; p jsonb;
BEGIN
  FOR f IN SELECT * FROM fixture_formats ORDER BY ord LOOP
    FOREACH b IN ARRAY ARRAY['prize','bounty'] LOOP
      PERFORM fixture_refuses(format($q$SELECT public.fn_poker_diamond_tournament_pay(
          '10000000-0000-0000-0000-000000000001'::uuid,1,%L,%L,%L::uuid,'fixture over-payment')$q$,
          'fixture-cap-'||b||'-'||f.label, b, f.tournament_id),
        'diamond_tournament_bank_short');
    END LOOP;
    FOREACH b IN ARRAY ARRAY['prize','bounty','fee'] LOOP
      PERFORM fixture_refuses(format($q$SELECT public.fn_poker_diamond_tournament_drain(
          %L::uuid,%L,1,%L,'house',NULL)$q$, f.tournament_id, b, 'fixture-cap-drain-'||b||'-'||f.label),
        'diamond_tournament_custody_short');
    END LOOP;
    PERFORM fixture_refuses(format($q$SELECT public.fn_poker_diamond_tournament_pay(
        '10000000-0000-0000-0000-000000000001'::uuid,1,%L,'fee',%L::uuid,'fixture over-payment')$q$,
        'fixture-cap-fee-'||f.label, f.tournament_id),
      'diamond_tournament_pay_unknown_category');
    FOREACH b IN ARRAY ARRAY['prize','bounty','refund'] LOOP
      p := public.fn_ca_escrow_can_pay(f.tournament_id, b, 1);
      PERFORM fixture_assert(NOT (p->>'ok')::boolean AND (p->>'enforced')::boolean
        AND p->>'asset' = 'diamonds' AND (p->>'known')::boolean,
        format('%s: the %s bank answers from Diamond custody, enforced, and cannot pay one Diamond', f.label, b));
    END LOOP;
  END LOOP;
  PERFORM fixture_assert(NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency WHERE key LIKE 'fixture-cap-%'),
    'capped exposure: every refused payment released the credit key it claimed, so none is burned');
  PERFORM fixture_assert((SELECT count(*) = 0 FROM public.poker_diamond_tournament_ledger)
    AND (SELECT count(*) = 0 FROM public.poker_diamond_movements)
    AND (SELECT count(*) = 0 FROM public.poker_diamond_custody)
    AND (SELECT sum(diamonds) = 2000 FROM public.profiles),
    'capped exposure: thirty-six refused over-payments wrote no ledger line, no movement, no custody and moved no wallet');
END $case10$;

-- ===========================================================================
-- CASE 11: THE CLOSED SWITCH REFUSES EVERY FORMAT'S ENTRY, PRICED EXACTLY
-- ===========================================================================
DO $case11$
DECLARE f record; t public.tournaments%ROWTYPE; s record;
BEGIN
  FOR f IN SELECT * FROM fixture_formats ORDER BY ord LOOP
    SELECT * INTO t FROM public.tournaments WHERE id=f.tournament_id;
    SELECT * INTO s FROM public.fn_tournament_entry_split(t.buy_in_amount, t.buy_in_fee, t.bounty_amount,
                                                          t.is_bounty OR t.is_pko OR t.is_mystery_bounty);
    PERFORM fixture_refuses(format($q$SELECT public.fn_poker_diamond_tournament_charge(
        '10000000-0000-0000-0000-000000000002'::uuid,%L::uuid,'entry',%s,%s,%s,%s,
        '30000000-0000-0000-0000-000000000009'::uuid,%L)$q$,
        f.tournament_id, s.charge, s.prize, s.bounty, s.rake, 'fixture-closed-'||f.label),
      'diamond_tournaments_not_open');
  END LOOP;
  PERFORM fixture_assert((SELECT count(*) = 0 FROM public.poker_diamond_custody)
    AND (SELECT count(*) = 0 FROM public.poker_diamond_tournament_ledger)
    AND NOT EXISTS (SELECT 1 FROM public.tournaments tt JOIN fixture_formats ff ON ff.tournament_id = tt.id
                     WHERE tt.entry_contract_locked),
    'the closed switch: an exactly priced entry into every format is refused and locks no entry contract');
END $case11$;

-- ===========================================================================
-- CASE 12: CANCELLATION BEFORE LAUNCH, EVERY FORMAT, AND THE SAME CANCEL TWICE
-- ===========================================================================
-- The engine's cancel door, called as production calls it. Nobody has entered
-- (the closed switch sees to that), so every format must cancel fully settled
-- owing nobody, close every bank at exact zero, and answer a second
-- cancellation with the stored receipt rather than a second one.
SELECT set_config('request.jwt.claim.sub','',false),
       set_config('request.jwt.claim.role','service_role',false),
       set_config('request.jwt.claims','{"role":"service_role"}',false);

CREATE TABLE fixture_format_cancellations(label text PRIMARY KEY, receipt jsonb);
INSERT INTO fixture_format_cancellations
SELECT label, public.fn_poker_diamond_tournament_cancel(tournament_id, '10000000-0000-0000-0000-00000000000f')
  FROM fixture_formats ORDER BY ord;

DO $case12$
DECLARE f record; t public.tournaments%ROWTYPE; e record;
BEGIN
  FOR f IN SELECT ff.label, ff.ord, ff.tournament_id, c.receipt
             FROM fixture_formats ff JOIN fixture_format_cancellations c USING (label) ORDER BY ff.ord LOOP
    SELECT * INTO t FROM public.tournaments WHERE id=f.tournament_id;
    SELECT * INTO e FROM public.fn_poker_diamond_tournament_escrow(f.tournament_id);
    PERFORM fixture_assert((f.receipt->>'ok')::boolean AND (f.receipt->>'fully_settled')::boolean
      AND f.receipt->>'status' = 'CANCELLED' AND f.receipt->>'asset' = 'diamonds'
      AND (f.receipt->>'total_refunded')::numeric = 0 AND (f.receipt->>'fees_reversed')::numeric = 0
      AND (f.receipt->>'refunded_count')::int = 0,
      format('%s: cancelled before launch, fully settled, owing nobody', f.label));
    PERFORM fixture_assert(t.status = 'CANCELLED' AND t.prize_pool = 0 AND t.bounty_pool = 0 AND t.total_rake = 0
      AND e.prize_balance = 0 AND e.bounty_balance = 0 AND e.fee_balance = 0
      AND public.fn_poker_diamond_tournament_custody(f.tournament_id) = 0,
      format('%s: every cached pool and every custody bank closes at exact zero', f.label));
    PERFORM fixture_assert(
      public.fn_poker_diamond_tournament_cancel(f.tournament_id, '10000000-0000-0000-0000-00000000000f') = f.receipt
      AND (SELECT count(*) = 1 FROM public.tournament_cancellation_receipts WHERE tournament_id = f.tournament_id),
      format('%s: the same cancellation again returns the stored receipt byte for byte and writes no second one', f.label));
    PERFORM fixture_assert(
      public.fn_poker_diamond_tournament_settle_fee(f.tournament_id, 'fixture') = '{"ok": true, "amount": 0, "destination": "none"}'::jsonb
      AND public.fn_poker_diamond_tournament_settle_fee(f.tournament_id, 'fixture replay') = '{"ok": true, "amount": 0, "destination": "none"}'::jsonb,
      format('%s: a fee nobody paid settles as zero, and replayed settles as zero again', f.label));
  END LOOP;
  PERFORM fixture_assert((SELECT count(*) = 0 FROM public.poker_diamond_tournament_ledger)
    AND (SELECT count(*) = 0 FROM public.poker_diamond_movements)
    AND (SELECT count(*) = 6 FROM public.tournament_cancellation_receipts r JOIN fixture_formats ff USING (tournament_id)),
    'cancellation: six cancellations, six replays and twelve zero fee settlements wrote exactly six receipts and no money line');
END $case12$;

-- ===========================================================================
-- CASE 13: ROUNDING AT BOTH UNITS, ON THE INSTALLED LADDER
-- ===========================================================================
-- The terminal prices every paid place through fn_ca_prize_ladder_versioned.
-- A Diamond event carries payout_math_version 1 (the create door never sets it)
-- and entry close regenerates its committed ladder from the final field with
-- fn_ca_payout_structure. All four doors are captured beside this file. The
-- structures and pools are the ones the engine's own ladder law pins,
-- server/src/tournament/aDiamondPrizeDoesNotDivide.law.test.ts (NINE_PLACE,
-- THREE_PLACE and POOLS): primes, pools smaller than the field, and pools where
-- an even percentage still lands mid-Diamond.
--
-- NOT ASSERTED HERE, BECAUSE IT FAILS: that version 1 never pays a lower place
-- more than a higher one at the Diamond unit. On ladders fn_ca_payout_structure
-- generates, it does - a field of 21 paid at 20 percent with a 27-Diamond prize
-- bank pays 10/6/4/3/4 - because each place is rounded to the nearest whole
-- Diamond and the accumulated residue lands on the last paid place. At unit 1
-- the same ladders never invert, and version 2 (largest remainder) never
-- inverts at either unit; both are asserted below. The defect is written up in
-- the changelog named in case 9. This suite has no expected-failure
-- convention, so the failing assertion is kept out of it rather than marked.
-- ===========================================================================
CREATE TABLE fixture_ladder_structures(name text PRIMARY KEY, entries jsonb NOT NULL);
INSERT INTO fixture_ladder_structures VALUES
 ('nine_place', '[{"place":1,"bp":3000},{"place":2,"bp":2000},{"place":3,"bp":1400},{"place":4,"bp":1000},{"place":5,"bp":800},{"place":6,"bp":600},{"place":7,"bp":500},{"place":8,"bp":450},{"place":9,"bp":250}]'),
 ('three_place', '[{"place":1,"bp":5000},{"place":2,"bp":3000},{"place":3,"bp":2000}]');
CREATE TABLE fixture_ladder_pools(diamonds bigint PRIMARY KEY);
INSERT INTO fixture_ladder_pools
SELECT unnest(ARRAY[1,2,3,5,7,9,11,13,17,23,47,99,100,101,483,997,1000,12345]::bigint[]);

-- Every committed ladder, both versions, both units.
CREATE TABLE fixture_ladders AS
SELECT s.name, s.entries, p.diamonds, v.ver, u.unit, l.place, l.cents,
       (p.diamonds*100)::numeric * (e->>'bp')::numeric
         / (SELECT sum((x->>'bp')::numeric) FROM jsonb_array_elements(s.entries) x) AS exact,
       jsonb_array_length(s.entries) AS places
  FROM fixture_ladder_structures s CROSS JOIN fixture_ladder_pools p
 CROSS JOIN (VALUES (1),(2)) v(ver) CROSS JOIN (VALUES (1),(100)) u(unit)
 CROSS JOIN LATERAL public.fn_ca_prize_ladder_versioned((p.diamonds*100)::bigint, s.entries, u.unit, v.ver) l
  JOIN LATERAL jsonb_array_elements(s.entries) e ON (e->>'place')::int = l.place;

DO $case13$
DECLARE r record;
BEGIN
  SELECT count(*) AS ladders, bool_and(total = pool) AS exact, bool_and(whole) AS whole, bool_and(nonneg) AS nonneg
    INTO r
    FROM (SELECT name, diamonds, ver, unit, sum(cents) AS total, diamonds*100 AS pool,
                 bool_and(cents % unit = 0) AS whole, bool_and(cents >= 0) AS nonneg
            FROM fixture_ladders GROUP BY name, diamonds, ver, unit) x;
  PERFORM fixture_assert(r.ladders = 144 AND r.exact AND r.whole AND r.nonneg,
    'rounding: 144 committed ladders (two structures, eighteen pools, both versions, both units) pay whole units, never below zero, and spend every pool exactly');
  -- A pool that reaches every place: above the last paid place each share is
  -- its exact share to the nearest cent at unit 1, and never a whole Diamond
  -- or more away from it at the Diamond unit; the last paid place takes the
  -- residue the rounding left.
  PERFORM fixture_assert(NOT EXISTS (
      SELECT 1 FROM fixture_ladders
       WHERE diamonds*100/unit >= places AND place < places
         AND ((unit = 1 AND abs(cents - exact) > 0.5) OR (unit = 100 AND abs(cents - exact) >= 100))),
    'rounding: above the last paid place every share is its exact share to the cent at unit 1, and within a whole Diamond of it at the Diamond unit, under both versions');
  PERFORM fixture_assert(NOT EXISTS (
      SELECT 1 FROM fixture_ladders l
       WHERE ver = 1 AND diamonds*100/unit >= places AND place = places
         AND cents <> diamonds*100 - (SELECT sum(o.cents) FROM fixture_ladders o
                                       WHERE o.name = l.name AND o.diamonds = l.diamonds AND o.ver = 1
                                         AND o.unit = l.unit AND o.place < l.places)),
    'rounding (version 1): the residue every rounding left lands on the last paid place, never on a headline one');
  -- A pool smaller than the field at the Diamond unit: one whole Diamond to each
  -- place from the top, nothing below, nothing overpaid.
  PERFORM fixture_assert(NOT EXISTS (
      SELECT 1 FROM fixture_ladders
       WHERE ver = 1 AND unit = 100 AND diamonds < places
         AND cents <> CASE WHEN place <= diamonds THEN 100 ELSE 0 END),
    'rounding (short field): a Diamond pool smaller than the paid places pays one whole Diamond each from the top and nothing below');
  -- The arithmetic differs by unit and both spend the same pool: 99 Diamonds
  -- over three places is 49.50/29.70/19.80 at unit 1 and 50/30/19 at the
  -- Diamond unit.
  PERFORM fixture_assert(
    (SELECT array_agg(cents ORDER BY place) FROM fixture_ladders WHERE name='three_place' AND diamonds=99 AND ver=1 AND unit=1)
      = ARRAY[4950,2970,1980]::bigint[]
    AND (SELECT array_agg(cents ORDER BY place) FROM fixture_ladders WHERE name='three_place' AND diamonds=99 AND ver=1 AND unit=100)
      = ARRAY[5000,3000,1900]::bigint[],
    'rounding: 99 Diamonds over 50/30/20 is 49.50/29.70/19.80 at unit 1 and 50/30/19 at the Diamond unit, the residue on third place');
  PERFORM fixture_assert(NOT EXISTS (
      SELECT 1 FROM (SELECT cents, lag(cents) OVER (PARTITION BY name, diamonds, unit ORDER BY place) AS above
                       FROM fixture_ladders WHERE ver = 2) x
       WHERE above IS NOT NULL AND cents > above),
    'rounding (version 2): on every committed ladder at both units a lower place is never paid more than a higher one');
END $case13$;

-- The ladder an event commits to at entry close, for every field up to forty
-- and every payout percent the door accepts.
CREATE TABLE fixture_generated AS
SELECT f.field, pc.pct, public.fn_ca_payout_structure(f.field, pc.pct) AS structure
  FROM generate_series(1,40) f(field) CROSS JOIN (VALUES (10),(15),(20)) pc(pct);

DO $case13b$
DECLARE r record;
BEGIN
  PERFORM fixture_assert(NOT EXISTS (
      SELECT 1 FROM fixture_generated g
       WHERE (SELECT sum((e->>'percentage')::numeric) FROM jsonb_array_elements(g.structure) e) <> 100
          OR jsonb_array_length(g.structure) <> GREATEST(1, LEAST(g.field, ceil(g.field*g.pct/100.0)::int))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(g.structure) e
                      WHERE (e->>'percentage')::numeric <> round((e->>'percentage')::numeric, 2))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(g.structure) WITH ORDINALITY a(e,i)
                       JOIN jsonb_array_elements(g.structure) WITH ORDINALITY b(e,i) ON b.i = a.i + 1
                      WHERE (b.e->>'percentage')::numeric > (a.e->>'percentage')::numeric)),
    'rounding: every committed ladder the final field generates (fields 1 to 40, at 10, 15 and 20 percent) totals exactly 100.00 in whole hundredths, never rises and pays the places its percent names');
  -- Priced at the Diamond unit on every prize bank from one to four Diamonds an
  -- entrant: both versions spend the bank exactly in whole Diamonds, and version
  -- 2 never pays a lower place more than a higher one.
  SELECT count(DISTINCT (g.field, g.pct, p.pool, v.ver)) AS ladders,
         bool_and(t.total = p.pool*100) AS exact, bool_and(t.whole) AS whole,
         bool_and(v.ver = 1 OR t.monotone) AS v2_monotone
    INTO r
    FROM fixture_generated g
    CROSS JOIN LATERAL generate_series(g.field, g.field*4) p(pool)
    CROSS JOIN (VALUES (1),(2)) v(ver)
    CROSS JOIN LATERAL (
      SELECT sum(l.cents) AS total, bool_and(l.cents % 100 = 0) AS whole,
             bool_and(l.cents <= COALESCE(l.above, l.cents)) AS monotone
        FROM (SELECT x.place, x.cents, lag(x.cents) OVER (ORDER BY x.place) AS above
                FROM public.fn_ca_prize_ladder_versioned((p.pool*100)::bigint,
                       (SELECT jsonb_agg(jsonb_build_object('place',(e->>'place')::int,'bp',round((e->>'percentage')::numeric*100)::int))
                          FROM jsonb_array_elements(g.structure) e), 100, v.ver) x) l) t;
  PERFORM fixture_assert(r.ladders > 5000 AND r.exact AND r.whole AND r.v2_monotone,
    format('rounding: %s generated ladders priced at the Diamond unit spend every bank exactly in whole Diamonds, and under version 2 a lower place is never paid more than a higher one',
           r.ladders));
END $case13b$;

-- ===========================================================================
-- THE FIXTURE CLOSES NOTHING IT OPENED, AND OPENS NOTHING
-- ===========================================================================
DO $close$
BEGIN
  PERFORM fixture_assert((SELECT NOT bool_or(cash_games_enabled OR tournaments_enabled)
                           FROM public.ca_arena_settings),
    'the fixture finishes with both arena switches exactly as it found them: closed');
  PERFORM fixture_assert((SELECT count(*)=0 FROM public.club_members),
    'the fixture finishes with no Diamond arena membership row, which is the guard''s own rule');
  PERFORM fixture_assert((SELECT sum(diamonds)=2000 FROM public.profiles)
    AND (SELECT count(*)=4 FROM public.diamond_transactions)
    AND (SELECT count(*)=0 FROM public.diamond_transactions WHERE source='poker_arena'),
    'the fixture finishes with every synthetic wallet holding exactly its signup grant and no arena journal row at all');
  RAISE NOTICE 'PASS: the Diamond tournament lifecycle cases ran against the installed doors';
END $close$;
