-- ═══════════════════════════════════════════════════════════════════════════
--  THE THIRTY-DAY WINDOW WAS HIDING MONEY (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On 2026-08-28 a sweep paid 20,110.50 of prize money that players had earned
-- and never been given, across 75 events, and then reported "owed across all
-- completed events: 0.00". That report was bounded by
-- `started_at > now() - interval '30 days'`, and the bound is the whole story:
-- 938 completed events sit OUTSIDE it and were never asked.
--
-- Asking them: 38 events, 11,238.80 owed, none of them newer than 2026-08-04.
--
-- SAME ROOT CAUSE, verified against the ledger rather than taken from the
-- reconciler (which had its own counting bug as recently as yesterday --
-- 20260828_reconcile_counts_a_debit_as_a_debit). Union Grand Championship
-- (NLH) 3b1a6dc9, pool 2,500.00: place 1 holds prize 750.00 and a matching
-- wallet_transactions row; places 2..9 hold prize 0.00, no wallet row of any
-- kind, and one identical backfill `eliminated_at` of 2026-08-28 03:12:31 --
-- a month after the event ended on 2026-07-31. The reconciler's expected
-- payouts for that event sum to exactly 2,500.00.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). Every place is paid on identical
-- terms; `is_horse` is not read anywhere below.
--
-- Payment goes through fn_tournament_payout_reconcile(id, true) -- the
-- sanctioned, idempotent path, keyed
-- `tourney:{id}:prize:{user}:{place}:reconcile`. Re-running this migration
-- pays nothing twice.
--
-- Dan approved the disbursement on 2026-08-29 and declined a recurring
-- all-history check, so the window that hid these is unchanged. That is a
-- deliberate decision, not an oversight.

CREATE TEMP TABLE zz_owed(tournament_id uuid PRIMARY KEY, expected numeric NOT NULL);

INSERT INTO zz_owed(tournament_id, expected) VALUES
    ('3b1a6dc9-0bf6-4ed6-9449-9df209179aa6'::uuid, 1750.00),
    ('f2c621c1-95a5-4975-aa06-36c001ec2cd4'::uuid, 1750.00),
    ('d8a6b6b1-5bc7-46d1-b552-a1ed3557e059'::uuid, 700.00),
    ('b29efbab-2334-43f1-b447-21266655f10f'::uuid, 700.00),
    ('73bac11a-1676-4067-8e51-4339796fa8ea'::uuid, 424.00),
    ('34a754f2-c0f3-4753-8a60-fca301d4e600'::uuid, 420.00),
    ('6c209826-e576-45c1-b90d-cd6158a79b77'::uuid, 420.00),
    ('0a6ef775-fdcc-4069-a4fc-73958feccf88'::uuid, 420.00),
    ('51dafd80-e3c2-4dab-98da-b4daf05a4de4'::uuid, 420.00),
    ('fb029c92-abdd-4e45-ae94-63816bc1f2cd'::uuid, 350.00),
    ('fd704444-686d-4416-898f-3c2c56f66be7'::uuid, 350.00),
    ('93c790cd-2492-4d54-b913-2246880c5a1c'::uuid, 350.00),
    ('97a74e04-ed19-480e-8d17-dd78c1d04ede'::uuid, 337.50),
    ('d9dad4c0-b6cf-4bc3-a4c9-a9668a26b3a5'::uuid, 270.00),
    ('91c7763a-4724-4dcc-8e91-cbc3053885df'::uuid, 270.00),
    ('a8924ca9-10d5-4ff3-be98-eda944546f5d'::uuid, 270.00),
    ('c493930c-19d8-4042-8c9c-19f1c4795023'::uuid, 240.00),
    ('e7e9c5d1-68bf-47c5-8a54-3a64ba717ed1'::uuid, 240.00),
    ('874d0be0-12e3-406d-82cf-6fe1a176afe6'::uuid, 180.00),
    ('39a46704-8abb-400a-84d3-ba29b7ee72e8'::uuid, 120.00),
    ('8a213070-91c0-430a-baf1-2d831f97a8a1'::uuid, 120.00),
    ('02ff2240-8d1c-41c6-a8fa-a427a9914a25'::uuid, 120.00),
    ('e5b1f6ce-70bb-41ce-9a3b-788f633a2a67'::uuid, 108.00),
    ('76ef71c6-6eb6-482b-935f-092f749e67fb'::uuid, 108.00),
    ('dcde46ec-ec93-4ad4-b8ca-7d864e95cc1d'::uuid, 79.50),
    ('dae75d6b-5490-4b78-9e05-70a76b2001ff'::uuid, 79.50),
    ('e2293e22-1051-447e-ae3e-b2ad8bee25fc'::uuid, 72.00),
    ('0d942b4a-ede2-4f55-b470-f642d2143605'::uuid, 72.00),
    ('abb9e1d2-cfb6-4a72-8fa2-d0e2283eb599'::uuid, 64.50),
    ('f4404dee-b8a1-4370-a5ba-620976c7c2d5'::uuid, 63.00),
    ('1b9419ee-b5f1-4cfe-8621-dba01b434761'::uuid, 63.00),
    ('4c4a800d-581a-43a6-9b93-e5bb1187bf2f'::uuid, 60.00),
    ('4918d37b-fd02-4598-aa49-29c2f5a0be7f'::uuid, 60.00),
    ('d03a5ad1-1f50-4f51-9b1b-9e17ec02f068'::uuid, 60.00),
    ('2724d193-ca04-4b2e-b446-f9832a6fcd9b'::uuid, 42.40),
    ('e8a34adb-5455-4502-9e1d-c1cfdb79c65b'::uuid, 42.40),
    ('4a618998-e691-427a-b953-11dcf9ac1e92'::uuid, 21.50),
    ('f1fe5b61-c616-4f44-8fc3-d902fcc1aa1f'::uuid, 21.50);

-- ── PRE-FLIGHT ───────────────────────────────────────────────────────────
-- The list above was measured minutes before this ran. If ANY event now
-- disagrees with what was measured, something else has touched it since and
-- this migration must not guess: abort and re-measure.
DO $$
DECLARE
  v_rows int;
  v_dry  numeric;
  v_bad  text;
BEGIN
  SELECT count(*) INTO v_rows FROM zz_owed;
  IF v_rows <> 38 THEN
    RAISE EXCEPTION 'expected 38 events to repair, found %', v_rows;
  END IF;

  SELECT round(sum(coalesce((fn_tournament_payout_reconcile(o.tournament_id, false)->>'total_top_up')::numeric, 0)), 2)
    INTO v_dry
    FROM zz_owed o;

  IF v_dry IS DISTINCT FROM 11238.80 THEN
    RAISE EXCEPTION 'dry run now says % owed, not the 11238.80 that was approved -- aborting rather than paying a number nobody signed off', v_dry;
  END IF;

  -- Nothing in the list may be a satellite: those award seats, not cash, and
  -- fn_tournament_payout_reconcile skips them by design (see 5.3 in the
  -- 2026-08-28 handoff). A satellite reaching this list would mean the
  -- candidate query changed underneath us.
  SELECT string_agg(t.id::text, ', ') INTO v_bad
    FROM zz_owed o JOIN tournaments t ON t.id = o.tournament_id
   WHERE coalesce(t.variant, '') = 'satellite' OR t.status <> 'COMPLETED';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to pay: not completed non-satellite events: %', v_bad;
  END IF;
END $$;

-- ── APPLY ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r          record;
  v_before   numeric;
  v_after    numeric;
  v_paid     numeric := 0;
BEGIN
  FOR r IN SELECT tournament_id FROM zz_owed ORDER BY tournament_id LOOP
    v_before := coalesce((fn_tournament_payout_reconcile(r.tournament_id, false)->>'total_top_up')::numeric, 0);

    PERFORM fn_tournament_payout_reconcile(r.tournament_id, true);

    v_after := coalesce((fn_tournament_payout_reconcile(r.tournament_id, false)->>'total_top_up')::numeric, 0);

    INSERT INTO tournament_payout_backfill_log(tournament_id, top_up, delta_before, delta_after)
    VALUES (r.tournament_id, v_before - v_after, v_before, v_after);

    v_paid := v_paid + (v_before - v_after);
  END LOOP;

  RAISE NOTICE 'paid % across % events', v_paid, (SELECT count(*) FROM zz_owed);
END $$;

-- ── POST-APPLY ASSERTIONS ────────────────────────────────────────────────
DO $$
DECLARE
  v_left numeric;
BEGIN
  SELECT round(sum(coalesce((fn_tournament_payout_reconcile(o.tournament_id, false)->>'total_top_up')::numeric, 0)), 2)
    INTO v_left
    FROM zz_owed o;

  IF v_left <> 0 THEN
    RAISE EXCEPTION 'after paying, % is still owed across the repaired events -- rolling back', v_left;
  END IF;
END $$;

DROP TABLE zz_owed;
