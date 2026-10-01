-- 20261001151646_the_conservation_delta_finds_a_seat_s_award_by_its_payout.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A SATELLITE AWARD IS FOUND BY ITS PAYOUT, NEVER BY ITS PLACE (2026-09-27).
-- Three installed functions joined tournament_satellite_awards to
-- tournament_payouts ON (tournament_id, place = position). This migration
-- moves every one of them to the award's own unique key, a.payout_id, and
-- then refuses to commit if any installed function still joins that way.
--
-- MONEY-TOUCHING. fn_pay_backed_payout_shortfalls decides backed top-up
-- payments from its inline copy of the conservation delta. Its cron runs it
-- with p_apply = false (report only) and it has written no alert and paid
-- nothing for the affected events, but the decision input changes, so this
-- ships HELD. No chips, tickets, payouts, ledger legs or alerts are written.
--
-- THE WRITER THAT BEGAN EMITTING NULL POSITIONS
--
--   satellite_multi_qualifier_receipt_v3 (file 20260917201651, commit
--   30c9b20e2, PR #4818; installed as schema_migrations 20260917231519,
--   2026-09-17 23:15 UTC). A receipt_version 3 satellite ends at
--   full-ticket award depth, and its survivors are "unranked co-qualifiers,
--   never an invented champion": the award row keeps a stable financial slot
--   in `place`, and the payout row keeps the finisher's real position, which
--   for a survivor is NULL. Read-only, 2026-10-01 15:15 UTC, satellite payouts
--   of settled satellites (tournament_satellite_settlements):
--     receipt_version 2: 1,755 payouts, 0 with a NULL position.
--     receipt_version 3: 626 payouts, 592 with a NULL position (331 ticket
--       deliveries, 95 cash deliveries, 166 seats), first 2026-09-18 10:10:28
--       UTC, last 2026-10-01 14:41:24 UTC and still being written.
--     Every one of the 2,381 has its award found by payout_id; no award has
--     a NULL place.
--   The writer is correct by design. The defect is every reader that assumed
--   place = position, which only held for ranked (version 2) receipts.
--
-- THE INVARIANT
--
--   At the writer: tournament_satellite_awards.payout_id is NOT NULL, UNIQUE
--   (tournament_satellite_awards_payout_id_key) and a FOREIGN KEY to
--   tournament_payouts, so the writer cannot record an award without naming
--   exactly one payout. The $writer$ block below refuses to commit unless that
--   key is still in force and every satellite payout of a settled satellite
--   has its award by payout_id. The $invariant$ block refuses to commit while
--   any installed function still joins an award to a payout by place =
--   position. fn_ca_satellite_settlement_receipt is deliberately untouched:
--   it refuses every receipt_version other than 2, already joins awards to
--   payouts ON p.id = a.payout_id, and compares place with the finisher's
--   tournament_players.position only as a version-2 contiguity proof.
--
-- WHAT CHANGES
--
--   1. fn_tournament_conservation_delta (detector), restated from its
--      installed body (20260927150903, pg_get_functiondef md5
--      46647067aa049dcb9bda93fa0a1a35b3, refused if it has moved): both
--      satellite terms join the award ON a.payout_id = sp.id, and
--      house-funded bubble protection (a chip_ledger 'correction' leg into
--      prize_liability paired one to one, per amount, with a
--      bubble_protection payout) counts as funding. Every other byte,
--      including the reviewed-void overlay return, is kept.
--      22 open fn_tournament_money_conservation alerts on 22 events at
--      2026-10-01 15:15 UTC (raised 2026-09-26 10:12 to 2026-10-01 11:12):
--      the 20 positive ones (20.00 ... 2,850.00) equal, to the penny, their
--      NULL-position ticket rows; the two at -180.00 are the bubble legs. The
--      new body, evaluated read-only on all 22 alerting events, reads 0.00 on
--      every one of them.
--   2. fn_pay_backed_payout_shortfalls (payer, money-touching): its
--      seat_income and seat_outgoing CTEs carry the same two joins. Patched in
--      place from the installed body (pg_get_functiondef md5
--      9078403312e51a873e6e7462555dcf7e, the body of 20260927173127 verified
--      by 20260927181709) so every other byte is preserved; the result must be
--      c4bee1c002152eeae5b85f1e4c9bde1a. Its delta does not carry the bubble
--      term; that only lowers two events already below zero, which are never
--      candidates, and is left for the owner of the payer.
--   3. fn_satellite_conservation_audit (detector): the funded-seat arm joins
--      the award ON a.payout_id = p.id. Patched in place from
--      462b1c631010e4bab0361967d2da2a75 to 5d847143055fab40063ee1d968f2bb36.
--
-- Law: tests/a-satellite-award-is-found-by-its-payout.law.test.ts
--      tests/the-conservation-delta-finds-a-seats-award-by-its-payout.law.test.ts
--
-- @live-proof: SELECT md5(prosrc) = 'e281e56110271d32957a26449b2b4033' FROM pg_proc WHERE oid = 'public.fn_tournament_conservation_delta(uuid)'::regprocedure
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. The delta, restated only over the exact body it was written against.
DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure))
       IS DISTINCT FROM '46647067aa049dcb9bda93fa0a1a35b3' THEN
    RAISE EXCEPTION 'fn_tournament_conservation_delta changed underneath this migration'
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,

      -- THE OVERLAY, FROM THE JOURNAL FIRST (2026-09-06). Two paths fund a
      -- guarantee and they keep different books: fn_apply_prize_guarantee
      -- writes a tournament_guarantee_overlays row, and the lock trigger
      -- fn_ca_fund_overlay_on_lock writes a chip_ledger leg
      -- (union_bank|club_treasury -> prize_liability, category 'overlay').
      -- The journal is the record of truth, so it is read first; the side
      -- table carries the 227 events older than the leg. GREATEST, never the
      -- sum: no event in the whole history has both, and if one ever does,
      -- they are two records of ONE funding, not two fundings.
      GREATEST(
        COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
           WHERE l.tournament_id = t.id
             AND l.category = 'overlay'
             AND l.to_type = 'prize_liability'), 0),
        COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
           WHERE o.tournament_id = t.id), 0)
      )
      -- A REVIEWED VOID RETURNS ITS OVERLAY (2026-09-27): one 'reversal' leg
      -- out of prize_liability back to the funder. The event kept none of it.
      - COALESCE((SELECT sum(r.amount) FROM public.chip_ledger r
           WHERE r.tournament_id = t.id AND r.category = 'reversal'
             AND r.from_type = 'prize_liability' AND r.from_entity_id = t.id
             AND r.metadata->>'kind' = 'reviewed_void_overlay_return'), 0)
      AS funded_overlay,

      -- BUBBLE PROTECTION THE HOUSE FUNDED WITH A CORRECTION LEG (2026-09-27).
      -- Two events of 2026-09-06 paid a 180.00 bubble_protection payout that the
      -- house funded with a chip_ledger 'correction' leg into prize_liability,
      -- not an 'overlay' leg, so the term above never saw it and both read
      -- -180.00 forever. A leg counts only when it pairs, one to one, with a
      -- bubble_protection payout of the same amount in the same event: per
      -- amount the term takes LEAST(legs, payouts), so one payout can never
      -- absorb two legs. A correction leg with no such payout (0ec5d7b2,
      -- 100.00) is some other correction and stays out, exactly as before.
      COALESCE((SELECT sum(c.amount * LEAST(c.n, b.n))
         FROM (SELECT l.amount, count(*) AS n
                 FROM public.chip_ledger l
                WHERE l.tournament_id = t.id
                  AND l.category = 'correction'
                  AND l.to_type = 'prize_liability'
                GROUP BY l.amount) c
         JOIN (SELECT bp.amount, count(*) AS n
                 FROM public.tournament_payouts bp
                WHERE bp.tournament_id = t.id
                  AND bp.source = 'bubble_protection'
                GROUP BY bp.amount) b
           ON b.amount = c.amount), 0) AS funded_bubble,

      -- ACKNOWLEDGED PRE-FUNDING MINTING. Replaces the 2026-08-27T12:00:00Z
      -- date literal that used to live here: same intent, but one auditable row
      -- per event carrying the exact amount instead of a comparison that
      -- silently forgave whatever fell the right side of it. An event with no
      -- baseline row is offset by nothing.
      COALESCE((SELECT b.amount FROM public.tournament_conservation_baseline b
         WHERE b.tournament_id = t.id), 0) AS acknowledged,

      -- A SEAT ARRIVING. The target's pool and rake were both credited by
      -- fn_award_satellite_seat with no wallet debit anywhere, so without this
      -- term the target is charged for a prize it was funded to pay. The seat
      -- names its target in metadata because the payout row belongs to the
      -- SATELLITE that paid it.
      --
      -- A TICKET ARRIVES WHEN IT IS REDEEMED, NOT WHEN IT IS ISSUED
      -- (2026-09-12). The holder of an unredeemed ticket has not entered this
      -- event and owes it nothing; crediting the target on issue invents an
      -- entry. Measured: gating this side the same way as the paid side below
      -- put "Wednesday Feature" at +40.00 and "DSS Wednesday $22 NLH
      -- Deepstack" at +20.00, both of which are correctly 0.00.
      --
      -- THE AWARD IS FOUND BY ITS PAYOUT, NOT BY ITS PLACE (2026-09-27).
      -- tournament_satellite_awards.payout_id is the award's own unique key to
      -- the payout row it delivered. The join below used to be (tournament_id,
      -- place = position). A receipt_version 3 (multi-qualifier) satellite
      -- leaves the payout position NULL for every unranked co-qualifier by
      -- design: 592 satellite payouts from 2026-09-18 10:10 to 2026-10-01
      -- 14:41 UTC (331 ticket deliveries, 95 cash deliveries, 166 seats), and
      -- every one of them has its award found by payout_id. For those the
      -- place join found no award and no ticket, so an ISSUED, never-redeemed
      -- ticket read as the legacy direct seat and was credited to its target.
      -- Measured on the 20 positive open "retained money it never paid out" alerts:
      -- every delta equals, to the penny, the NULL-position ticket rows naming
      -- that target (80.00 = 4 x 20.00 on 904e3190 ... 2,070.00 on df7a5891).
      -- Every award row carries payout_id, so no row loses its award here.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.payout_id = sp.id
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.metadata->>'satellite_target_id' = t.id::text
          -- no award row = the legacy direct-seat path, which always arrived
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          -- no ticket row = never a ticket; a ticket must be redeemed
          AND (k.id IS NULL OR k.status = 'redeemed')), 0) AS seat_income,

      -- A SEAT LEAVING. The satellite really did pay this out; it simply paid
      -- it in a seat rather than in chips, so no 'prize' credit exists to find.
      --
      -- A TICKET IS THAT SAME SEAT, HELD RATHER THAN TAKEN (2026-09-12), so it
      -- leaves on ISSUE. A cancelled ticket does not leave at all - its value
      -- comes back as cash and the 'prize' credit above already counts it - and
      -- a cash delivery was never a seat in the first place.
      --
      -- ... AND A CASH DELIVERY WITH NO TICKET ROW IS STILL A CASH DELIVERY
      -- (2026-09-25). The cancelled-ticket case above is one way a ticket turns
      -- into cash. The other leaves NO tournament_satellite_awards row and NO
      -- tournament_tickets row at all: fn_settle_satellite_tournament pays the
      -- place through fn_credit_and_log with the wallet reason "Satellite ticket
      -- paid in cash because target admission was definitively unavailable",
      -- and the payout row keeps source='satellite_ticket' with a NULL position.
      -- Both COALESCE defaults above then read it as the legacy direct-seat
      -- path, and the 'prize' credit counts it a second time.
      --
      -- Measured: 40 satellites, 2,320.00, every delta explained to the penny
      -- as wallet_prizes + seat_paid_out - payout_total. Over the whole 71,785
      -- event scan the extra condition touches 41 events, fixes 41, and breaks
      -- none. Keying this on recorded_by='credit_and_log' instead - the obvious
      -- first guess - would have broken 245 healthy events to fix the same 41,
      -- because for those the cancelled-ticket gate had already excluded the row
      -- and this would have subtracted it twice.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.payout_id = sp.id
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.tournament_id = t.id
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          AND COALESCE(k.status, 'issued') IN ('issued','redeemed')
          AND NOT (
            k.id IS NULL
            AND EXISTS (SELECT 1 FROM public.wallet_transactions w
                         WHERE w.related_entity_id = t.id
                           AND w.type = 'credit' AND w.category = 'prize'
                           AND w.user_id = sp.user_id
                           AND w.amount  = sp.amount)
          )), 0) AS seat_paid_out
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
    + m.funded_bubble
    + m.acknowledged
    + m.seat_income
    - m.seat_paid_out
  , 2)
  FROM m;
$function$;

COMMENT ON FUNCTION public.fn_tournament_conservation_delta(uuid) IS
  'Money conservation for one tournament. A satellite prize DELIVERED AS CASH is counted once, as a prize, never also as a seat leaving (2026-09-25). A satellite payout finds its award by payout_id, never by place, and house-funded bubble protection counts as funding (2026-09-27).';

REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;

-- The restated delta is exactly the reviewed body, with its catalog intact.
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_tournament_conservation_delta(uuid)'::regprocedure
       AND md5(p.prosrc) = 'e281e56110271d32957a26449b2b4033'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_tournament_conservation_delta is not the reviewed definition'
      USING ERRCODE = '55000';
  END IF;
END
$post$;

-- Re-prove the measured outcome inside the transaction. An event that is not
-- in this database (a fresh branch) is skipped, never invented.
DO $prove$
DECLARE
  v_id uuid;
  v_d numeric;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[
    '904e3190-0ed8-44df-95a3-ad74eb3ca406','cf03a62c-3f77-43b4-82ff-c68c8b1cace1',
    'df7a5891-e8a9-432f-a266-946276e6ade0','c0b9d216-d37d-46bd-9ec8-a9fb1f192393',
    'a1c71db1-fec0-481e-a1e7-69c5049a6321','a449e853-4ee1-4e36-bd38-8fe904664d7c',
    'f7412940-5644-4194-8d57-4a97c182bf04','e8a554d4-34fe-4cbc-87da-72522a93ef2d',
    '72ef7181-0c5d-491a-b4ef-390e954ee4aa','f79bc050-1792-43de-8d19-634562b78f57',
    '799952bc-bf92-4cfa-89f3-987b8bb8c90b','5b0403d1-7d8e-4c3f-8da9-c44c42d20e0b',
    'fd56353d-ecaa-40c1-9441-2a8eadb2b721',
    -- raised 2026-09-28 to 2026-10-01 by the same NULL-position tickets
    '7e6c8489-a39b-45c4-9aee-cef3aec11cbe','331fb2ad-16a5-423f-9eea-14dc3c7f24f4',
    '0c37b5e3-878e-4e21-8703-e9afcd10c980','26fcf1f3-3fb0-4e19-93ab-ff844e9ce4d9',
    'f84852af-1a3b-49b5-9c40-6aabd92000f7','3b8eec8e-e6e4-46c8-b610-7b26cc575ea1',
    -- controls that already balanced and must still balance
    '8da2c394-da34-46aa-85d9-1e26d4139477','c905f397-6842-4322-8c61-89a108ad414b',
    '690bfcb0-2dca-44f6-8773-b052b49f5603','13dd6b98-b882-4690-a479-3a6f77783ad6',
    '1068cd04-41c8-4168-83cb-243ebe693918','527ec5bb-a7f8-462b-b73f-54b1163c328d',
    -- raised again on 2026-09-27 after the first measurement
    'fb3d92ce-ae0c-4f4a-bf3b-b2866726ba84','91abcb33-51f5-424d-9522-8b2f2c8bae18',
    'a35faa53-85dd-4824-bdf1-c250f6f07d53',
    -- the two reviewed voids of 20260927150903 stay neutral
    '615783bf-15e3-40b7-9368-75f21b6ac53b','5a387a75-754a-416e-8fee-b85b15fc2702'
  ]::uuid[] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_id);
    v_d := public.fn_tournament_conservation_delta(v_id);
    IF v_d IS DISTINCT FROM 0.00 THEN
      RAISE EXCEPTION 'conservation delta for % reads %, expected 0.00', v_id, v_d;
    END IF;
  END LOOP;

  -- The one correction leg into prize_liability with no bubble_protection
  -- payout: the new term must leave it exactly where it was.
  v_id := '0ec5d7b2-7c1c-44a9-882d-489b8ffd086f';
  IF EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_id) THEN
    v_d := public.fn_tournament_conservation_delta(v_id);
    IF v_d IS DISTINCT FROM -44.80 THEN
      RAISE EXCEPTION 'conservation delta for % reads %, expected -44.80 (unchanged)', v_id, v_d;
    END IF;
  END IF;
END
$prove$;

-- 2 and 3. Patch the payer and the audit in place, from their exact installed
-- bodies. regexp_replace keeps every other byte; the pre and post md5 guards
-- refuse a body that has moved underneath this migration.
DO $patch$
DECLARE
  v_fn  regprocedure;
  v_old text;
  v_new text;
  v_cat record;
  v_hits int;
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_pay_backed_payout_shortfalls(boolean,integer)',
       'ON a\.tournament_id = sp\.tournament_id AND a\.place = sp\.position',
       'ON a.payout_id = sp.id', 2,
       '9078403312e51a873e6e7462555dcf7e', 'c4bee1c002152eeae5b85f1e4c9bde1a'),
      ('public.fn_satellite_conservation_audit(integer)',
       'ON a\.tournament_id = p\.tournament_id AND a\.place = p\.position',
       'ON a.payout_id = p.id', 1,
       '462b1c631010e4bab0361967d2da2a75', '5d847143055fab40063ee1d968f2bb36')
    ) v(fn, pat, rep, hits, pre, post)
  LOOP
    v_fn  := r.fn::regprocedure;
    v_old := pg_get_functiondef(v_fn);
    IF md5(v_old) IS DISTINCT FROM r.pre THEN
      RAISE EXCEPTION '% changed underneath this migration: md5 %, expected %',
        r.fn, md5(v_old), r.pre USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO v_hits FROM regexp_matches(v_old, r.pat, 'g');
    IF v_hits <> r.hits THEN
      RAISE EXCEPTION '% has % place joins, expected %', r.fn, v_hits, r.hits
        USING ERRCODE = '55000';
    END IF;
    SELECT proowner, proacl, proconfig INTO STRICT v_cat FROM pg_proc WHERE oid = v_fn;
    v_new := regexp_replace(v_old, r.pat, r.rep, 'g');
    IF md5(v_new) IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION '% patched body md5 %, expected %', r.fn, md5(v_new), r.post
        USING ERRCODE = '55000';
    END IF;
    EXECUTE v_new;
    IF md5(pg_get_functiondef(v_fn)) IS DISTINCT FROM r.post
       OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                        AND proowner = v_cat.proowner
                        AND proacl IS NOT DISTINCT FROM v_cat.proacl
                        AND proconfig IS NOT DISTINCT FROM v_cat.proconfig) THEN
      RAISE EXCEPTION '% readback differs after the patch', r.fn USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$patch$;

-- THE WRITER'S INVARIANT: the award names its payout by a hard key, and every
-- satellite payout of a settled satellite has its award by that key. This is
-- what every reader above now relies on instead of the payout's position.
DO $writer$
DECLARE
  v_missing bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.tournament_satellite_awards'::regclass
                    AND attname = 'payout_id' AND attnotnull AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.tournament_satellite_awards'::regclass
                       AND c.contype = 'u'
                       AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                              WHERE attrelid = c.conrelid AND attname = 'payout_id')])
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.tournament_satellite_awards'::regclass
                       AND c.contype = 'f'
                       AND c.confrelid = 'public.tournament_payouts'::regclass
                       AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                              WHERE attrelid = c.conrelid AND attname = 'payout_id')]) THEN
    RAISE EXCEPTION 'tournament_satellite_awards.payout_id is no longer a NOT NULL, UNIQUE foreign key to tournament_payouts'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_missing
    FROM public.tournament_payouts sp
    JOIN public.tournament_satellite_settlements s ON s.tournament_id = sp.tournament_id
   WHERE sp.source IN ('satellite_seat','satellite_ticket')
     AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_awards a WHERE a.payout_id = sp.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% satellite payout(s) of settled satellites have no award by payout_id', v_missing
      USING ERRCODE = '55000';
  END IF;
END
$writer$;

-- THE INVARIANT: no installed function may join the award table to a payout
-- by place = position. Checked across every schema, after every change above.
DO $invariant$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_bad
    FROM pg_proc p
   WHERE p.prosrc ~ 'tournament_satellite_awards\s+(\w+)\s+ON\s+\1\.tournament_id\s*=\s*(\w+)\.tournament_id\s+AND\s+\1\.place\s*=\s*\2\.position';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a satellite award is still located by place = position in: %', v_bad
      USING ERRCODE = '55000';
  END IF;
END
$invariant$;

COMMIT;
