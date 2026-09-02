-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830200105; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Reverse the prize payouts of the Sunday $200 Deep Stack run that never
-- legitimately finished (dfae9288). See v1 for the full reasoning; v1 aborted
-- atomically on chip_ledger.performed_by NOT NULL and applied nothing.
-- performed_by is the system actor the reconciler itself writes under.
--
-- WHAT HAPPENED. During the Supabase RESIZING window on 2026-08-30 the event
-- was force-completed at level 7 while NINETY players were still 'playing'
-- with 2,730,654 tournament chips live. Positions 1-18 were assigned by
-- CHIPSTACK, not by elimination, and the full 20,880 pool went to the top 9.
--
-- WHY REVERSE. Dan is relaunching this same event at 21:00 UTC. A prize paid
-- for a run being re-run is not a valid prize, and leaving it would have the
-- club fund its 20k guarantee twice. Approved by Dan for ALL NINE finishers:
-- eight horses and one human treated identically, because HORSES ARE PLAYERS
-- and an is_horse branch here would be the exact bug that law forbids.
--
-- SOURCE OF TRUTH is the reconciler's adjustment rows, which carry the club
-- the money actually moved in. club_members.updated_at is NOT proof —
-- StackWolf has two rows touched in the same second for one credit, so
-- matching on it would have debited the wrong club.
--
-- NOT fn_debit_chips: its UPDATE casts `p_amount::integer`, and three prizes
-- carry cents (1670.40, 1252.80, 730.80), so it would strand 1.20 chips and
-- make the reversal unequal to the payout. Logged separately for repair.

DO $$
DECLARE
  v_rows    int;
  v_total   numeric;
  v_already int;
  v_neg     int;
  v_actor   uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
BEGIN
  SELECT count(*) INTO v_already
  FROM chip_ledger
  WHERE description = 'reversal: dfae9288 dead-run payout returned to treasury';

  IF v_already > 0 THEN
    RAISE NOTICE 'Reversal already applied (% rows) — no-op.', v_already;
    RETURN;
  END IF;

  CREATE TEMP TABLE _rev ON COMMIT DROP AS
  SELECT cl.to_entity_id AS user_id, cl.club_id, cl.amount
  FROM chip_ledger cl
  JOIN tournament_players tp
    ON tp.user_id = cl.to_entity_id
   AND tp.tournament_id = 'dfae9288-40e2-485d-8c97-a13dd53ab483'
  WHERE cl.created_at > now() - interval '3 hours'
    AND cl.category = 'adjustment'
    AND cl.description LIKE 'auto-audited club_members.chip_balance delta%'
    AND cl.amount = tp.prize
    AND tp.prize > 0;

  SELECT count(*), coalesce(sum(amount),0) INTO v_rows, v_total FROM _rev;

  IF v_rows <> 9 THEN
    RAISE EXCEPTION 'Expected 9 payout rows to reverse, found %', v_rows;
  END IF;
  IF v_total <> 20880.00 THEN
    RAISE EXCEPTION 'Expected total 20880.00 to reverse, found %', v_total;
  END IF;

  SELECT count(*) INTO v_neg
  FROM _rev r
  JOIN club_members cm ON cm.user_id = r.user_id AND cm.club_id = r.club_id
  WHERE cm.chip_balance < r.amount;
  IF v_neg > 0 THEN
    RAISE EXCEPTION '% wallet(s) hold less than their payout; refusing to overdraw', v_neg;
  END IF;

  PERFORM 1
  FROM club_members cm
  JOIN _rev r ON r.user_id = cm.user_id AND r.club_id = cm.club_id
  FOR UPDATE;

  UPDATE club_members cm
     SET chip_balance = cm.chip_balance - r.amount,
         updated_at   = now()
    FROM _rev r
   WHERE cm.user_id = r.user_id AND cm.club_id = r.club_id;

  INSERT INTO chip_ledger
    (id, performed_by, from_type, from_entity_id, to_type, amount, category,
     description, club_id, tournament_id, created_at)
  SELECT gen_random_uuid(), v_actor, 'player_wallet', r.user_id, 'club_treasury',
         r.amount, 'adjustment',
         'reversal: dfae9288 dead-run payout returned to treasury',
         r.club_id, 'dfae9288-40e2-485d-8c97-a13dd53ab483', now()
  FROM _rev r;

  -- Clear the prize marks so the relaunched event cannot re-pay from them.
  UPDATE tournament_players
     SET prize = 0
   WHERE tournament_id = 'dfae9288-40e2-485d-8c97-a13dd53ab483'
     AND prize > 0;

  RAISE NOTICE 'Reversed % payouts totalling % chips.', v_rows, v_total;
END $$;
