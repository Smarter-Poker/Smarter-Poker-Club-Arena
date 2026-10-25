-- 20261025082356_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file changes TWO readers, each by anchored insertions
-- into its installed definition:
--   FUNCTION smarter_private.f06_movement_prior(uuid,uuid)
--   FUNCTION smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)
-- Their one consumer, smarter_private.f06_assert_movement(uuid), reads only
-- proof->'roster', proof->'eliminated' and their counts, and is not touched.
-- It schedules nothing, retries nothing, writes no row and moves no chip.
--
-- REPLACES 20261025030421 (merged, never installed). That file's install was
-- refused and rolled back whole: 20261025052637
-- (a_refunded_diamond_or_free_entry_is_not_a_second_entry, from file
-- 20261025042215) had moved f06_movement_never_dealt_prior from 63184403 to
-- 35dbc3c7 first. This file carries the same two edits, the never-dealt
-- anchors re-based onto the live 35dbc3c7 definition. Every anchor is found
-- exactly once there, none of them sits inside 052637's passage except the
-- one line R tightens, and 052637's rule (diamond custody and free-entry
-- unregistration refunds, chip-only refund sum) is kept intact. The
-- f06_movement_prior edit is unchanged (pre ddbca56b, post 0c3f0b7c).
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM THE DEFINITIONS AND FROM ROWS (2026-10-24)
--
-- G2. A player who BUSTED in the proven hand on this table, then rebought or
-- re-entered and was seated in a DIFFERENT chair, refuses the dealt proof
-- with F06_MOVEMENT_SEAT_CHANGED. process_tournament_rebuy lets
-- fn_ca_choose_tournament_seat_locked pick the table of the event with the
-- most free chairs, so the new chair is often on another table: of the last
-- five rebought knockout candidates (02:27-02:52 UTC) every one was seated in
-- a different chair than the one it busted from, on another table, and three
-- of the five old chairs had already been taken by somebody else. The proof's
-- purchase loop raises the player's held stack to the rebuy grant, then the
-- seat lookup finds only the old chair (vacated at 0, or now another
-- player's), so every re-admission of such a park refuses and the table can
-- neither deal nor be broken.
--
-- G3. A chair that never dealt whose entry, rebuy or arrival is proven, and
-- whose player then bought an ADD-ON before the park, refuses
-- f06_movement_never_dealt_prior with F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN:
-- entry_proven refuses any add-on receipt, flag or ledger leg, and the rebuy
-- and arrival rules refuse any later receipt.
--
-- R. The refunded-earlier-entry rule (20261024232734, widened by 052637 to
-- refunded diamond and free entries) admits another receipt of the player
-- observed before the CURRENT RECEIPT; it is tightened so that receipt must
-- also predate the current registration itself, whatever its asset.
--
-- WHAT CHANGES
--
-- f06_movement_prior, hand branch: when the hand wrote the player 0 and its
-- first purchase since is a rebuy or re-entry, that purchase's immutable
-- whole-transaction result (entry_purchase_idempotency_receipts,
-- tournament_chip_purchase, keyed by that purchase key) is read. It must be
-- the v1 atomic purchase, seated, from the player's knockout candidate in
-- exactly this hand on this table and the chair this hand dealt (rebought
-- from 0), granting exactly the first purchase's chips, into another chair;
-- and the chair this hand dealt must hold nothing of the player (vacated at 0,
-- or taken since this hand by another occupant, which is proven on its own
-- rows). Then:
--   * chair on THIS table: that open chair row is the seat, and every check
--     below (seat stack = receipted chips, registration on that chair, roster
--     counts) runs unchanged. The arrival loop excludes players the hand
--     dealt, so the chair is counted once, by this item. Recorded under
--     receipts.rechaired.
--   * chair on ANOTHER table of the event: the player departed by that rebuy.
--     Its registration must be playing on exactly that table and chair, it
--     must sit there in exactly that chair row, and it must hold no open chair
--     here. Recorded under receipts.departed; neither roster nor eliminated.
-- Anything else refuses exactly as before.
--
-- f06_movement_never_dealt_prior: add-ons are admitted exactly as the dealt
-- proof's purchase loop admits them: this registration's latest receipts are
-- 'addon' funding receipts, each granting the event's add-on chips (or its
-- starting chips) and each recorded with the registration image holding
-- exactly the running stack, all after the receipt before them. When the rules
-- refuse the chair as it stands, they are taken ONCE MORE on the chair as it
-- stood before those add-ons (seat and registration chips less their grants,
-- the add-on flag clear, the receipt before them as the funding receipt) with
-- exactly those add-on receipts and their own chip ledger legs set aside, and
-- for an arrival every add-on after its move. So the seat stack must equal the
-- base grant plus the add-ons. The roster still carries the live rows; the
-- entry records the add-ons under 'addons'. Any other receipt, ledger leg or
-- stack still refuses.
--
-- A proof that needs none of these rules is byte-identical: the dealt proof's
-- passages run only for a busted, bought-back player whose purchase result
-- names another chair; the never-dealt proof takes its second pass only when
-- the first refused; and every inserted predicate is a no-op on an empty set.
-- Removing the inserted passages reproduces each pre-image byte for byte
-- (asserted below, before anything is installed).
--
-- Same signatures, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility and search_path (asserted).
--
-- PROVED FIRST (CLAUDE.md 11.5)
--   (a) live: in ONE Supabase MCP call, READ ONLY, row locks stripped, the
--       installed and the patched definitions were built as pg_temp copies
--       from the live text and both run on every open park_requested/begun
--       f06_operations row, ending in RAISE (rolled back). The patched text
--       matched both post-image md5s below, and the outcome was identical on
--       every row: same=34 diff=0 (2026-10-25 ~08:30 UTC, against the live
--       35dbc3c7 / ddbca56b pair; all 34 refusals unchanged: 25
--       PRIOR_INCOMPLETE, 8 WHOLE_ROSTER_REQUIRED, 1 UNRESOLVED_HAND_CUSTODY).
--   (b) local throwaway PostgreSQL 16 holding only the columns these readers
--       read, both live definitions loaded (md5 identical to production),
--       this file applied, and the G2 / G3 / R cases built as fixtures:
--       every G2 and G3 case refused by the old proof and admitted by the
--       new one, every negative refused by both, every case needing no new
--       rule byte-identical, and R refusing only a receipt recorded after
--       the registration. 052637's rules compose: a refunded free or diamond
--       earlier entry is byte-identical, is admitted with add-ons by the new
--       proof only, refuses under the new proof only when recorded after the
--       registration, and an active diamond custody refuses under both
--       (docs/changelog/2026-10-24-a-busted-rebuy-into-another-chair-and-a-
--       never-dealt-add-on-are-movement-evidence.md).
--
-- Release: no row is touched. The engine's existing park re-admission
-- (startParkedMovementEngine -> fn_f06_admit_parked_movement) takes the proof
-- on its next pass. No repair job, no abort, no seat write.
--
-- NOT TOUCHED: f06_assert_movement, fn_f06_admit_parked_movement,
-- process_tournament_rebuy, fn_ca_choose_tournament_seat_locked.
--
-- Pinned by tests/a-busted-rebuy-into-another-chair-is-movement-evidence.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='ab72d64575eae5cf77e6b004dd5ee5f6' AND md5(pg_get_functiondef(oid))='0c3f0b7cb997eb761a7295d49df24bc9' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='dbda1e1dab654980f31706a04f8b6de5' AND md5(pg_get_functiondef(oid))='0ff3bcaef0476a3dc46d6d6931515bb7' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- ---------------------------------------------------------------------------
-- G2: f06_movement_prior
-- ---------------------------------------------------------------------------
DO $rechaired$
DECLARE
  v_fn  regprocedure := 'smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure;
  v_pre text; v_src text; v_back text; v_find text[]; v_repl text[]; i integer; v_n integer;
  v_acl text; v_owner text; v_secdef boolean; v_config text[]; v_vol "char";
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig, p.provolatile
    INTO v_pre, v_acl, v_owner, v_secdef, v_config, v_vol
    FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_pre) <> 'ddbca56b65a99f017fb86e791b2fb971'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> 'd21b415b4754a19147cce0160de59479' THEN
    RAISE EXCEPTION 'F06_REBUY_RECHAIRED_PREIMAGE_DRIFT: f06_movement_prior is %, read it before re-running', md5(v_pre);
  END IF;
  -- Each pair is an anchor of the pre-image (found exactly once) and that
  -- anchor with a passage inserted.
  v_find := ARRAY[
$a1$ bust public.hand_atomic_commits;
BEGIN
$a1$,
$a2$ rebought:=NULL; bought:=0;
$a2$,
$a3$ bought:=bought+1; IF bought=1 AND p.op IN ('rebuy','reentry') THEN rebought:=p.at; END IF;
$a3$,
$a4$ IF item ? 'hand' THEN
 SELECT * INTO seat FROM public.table_seats WHERE id=(x->>'seat_id')::uuid AND table_id=p_table
$a4$,
$a5$ OR ((x->>'stack')::numeric=0 AND held>0 AND left_at IS NULL AND joined_at>=rebought)) FOR UPDATE;
 ELSIF item ? 'entry' THEN
$a5$,
$a6$ ||CASE WHEN rebases='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('rebased',rebases) END) END;
$a6$];
  v_repl := ARRAY[
$b1$ bust public.hand_atomic_commits;
 -- A player busted in the proven hand and bought back into another chair (2026-10-24).
 rekey text; reop text; regain numeric; repurchase public.entry_purchase_idempotency_receipts;
 departed jsonb:='[]'; rechaired jsonb:='[]';
BEGIN
$b1$,
$b2$ rebought:=NULL; bought:=0;
 rekey:=NULL; reop:=NULL; regain:=NULL;
$b2$,
$b3$ bought:=bought+1; IF bought=1 AND p.op IN ('rebuy','reentry') THEN rebought:=p.at; END IF;
 IF bought=1 AND p.op IN ('rebuy','reentry') THEN rekey:=p.k; reop:=p.op; regain:=gained; END IF;
$b3$,
$b4$ IF item ? 'hand' THEN
 -- Busted in this hand and bought back in by a rebuy or re-entry the event
 -- seated in ANOTHER chair, on this table or on another table of this event
 -- (process_tournament_rebuy lets fn_ca_choose_tournament_seat_locked pick
 -- the table with the most free chairs) (2026-10-24). Only that purchase's
 -- own immutable whole-transaction result names the chair: the v1 atomic
 -- purchase keyed by the first purchase since this hand, seated, from this
 -- player's knockout candidate in exactly this hand, on this table, from the
 -- chair this hand dealt it, rebought from 0, granting exactly that
 -- purchase's chips, into a different chair. The chair this hand dealt holds
 -- nothing of the player: it is vacated at 0, or taken since this hand by
 -- another occupant, whose own rows prove it. On another table the player
 -- departed by that rebuy: its registration plays there in exactly that
 -- chair, it sits in exactly that chair row, and it holds no chair here, so
 -- it is neither roster nor eliminated here. On this table that chair is the
 -- seat every check below proves. Anything else still refuses.
 repurchase:=NULL;
 IF (x->>'stack')::numeric=0 AND bought>=1 AND rekey IS NOT NULL AND NOT item ? 'credit' THEN
 SELECT q.* INTO repurchase FROM public.entry_purchase_idempotency_receipts q
 JOIN public.tournament_knockout_candidates kc ON kc.id=(q.response->>'candidate_id')::uuid
 WHERE q.key_domain='tournament_chip_purchase' AND q.idempotency_key=rekey
 AND q.request->>'version'='v1' AND q.request->>'user_id'=x->>'user_id'
 AND q.request->>'tournament_id'=p_tournament::text AND q.request->>'idempotency_key'=rekey
 AND q.request->>'rebuy_type'=reop AND q.request->>'candidate_id'=kc.id::text
 AND q.response->'success'='true'::jsonb AND q.response->'seated'='true'::jsonb
 AND q.response->>'atomic_tournament_chip_purchase'='v1' AND q.response->>'rebuy_type'=reop
 AND q.response->>'candidate_id'=kc.id::text AND q.response->>'candidate_state'='rebought'
 AND (q.response->>'stack')::numeric=regain AND (q.response->>'new_stack')::numeric=regain
 AND (q.response->>'chips_added')::numeric=regain
 AND NULLIF(q.response->>'table_id','') IS NOT NULL AND NULLIF(q.response->>'seat_id','') IS NOT NULL
 AND q.response->>'seat_id' IS DISTINCT FROM x->>'seat_id'
 AND q.claimed_at IS NOT NULL AND q.completed_at IS NOT NULL AND q.completed_at>=q.claimed_at
 AND kc.tournament_id=p_tournament AND kc.eliminated_user_id=(x->>'user_id')::uuid AND kc.state='rebought'
 AND kc.table_id=p_table AND kc.hand_id=a.hand_id AND kc.hand_number=a.hand_number
 AND kc.seat_id=(x->>'seat_id')::uuid AND kc.seat_joined_at=(x->>'seat_joined_at')::timestamptz
 AND kc.stack_after=0 AND kc.resolved_at IS NOT NULL AND kc.resolved_at>=rebought
 AND (EXISTS(SELECT 1 FROM public.table_seats os WHERE os.id=(x->>'seat_id')::uuid AND os.table_id=p_table
  AND os.user_id=(x->>'user_id')::uuid AND os.joined_at=(x->>'seat_joined_at')::timestamptz
  AND os.left_at IS NOT NULL AND os.stack=0)
 OR EXISTS(SELECT 1 FROM public.table_seats os WHERE os.id=(x->>'seat_id')::uuid AND os.table_id=p_table
  AND os.left_at IS NULL AND os.occupancy_id IS NOT NULL AND os.user_id IS DISTINCT FROM (x->>'user_id')::uuid
  AND os.joined_at>a.committed_at));
 END IF;
 IF repurchase.idempotency_key IS NOT NULL AND repurchase.response->>'table_id' IS DISTINCT FROM p_table::text THEN
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=(x->>'user_id')::uuid FOR UPDATE;
 IF registration.id IS NULL OR registration.status IS DISTINCT FROM 'playing' OR registration.eliminated_at IS NOT NULL
 OR registration.table_id::text IS DISTINCT FROM repurchase.response->>'table_id'
 OR registration.seat_number IS DISTINCT FROM (repurchase.response->>'seat_number')::integer
 OR NOT EXISTS(SELECT 1 FROM public.table_seats ns JOIN public.tables nt ON nt.id=ns.table_id
  WHERE ns.id::text=repurchase.response->>'seat_id' AND ns.table_id::text=repurchase.response->>'table_id'
  AND nt.tournament_id=p_tournament AND ns.user_id=(x->>'user_id')::uuid AND ns.seat_number=registration.seat_number
  AND ns.left_at IS NULL AND ns.occupancy_id IS NOT NULL AND ns.joined_at>=rebought)
 OR EXISTS(SELECT 1 FROM public.table_seats ns WHERE ns.table_id=p_table AND ns.user_id=(x->>'user_id')::uuid AND ns.left_at IS NULL) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000'; END IF;
 departed:=departed||jsonb_build_array(jsonb_build_object('accepted',x,'purchase_key',rekey,'operation',reop,
 'candidate_id',repurchase.response->>'candidate_id','table_id',repurchase.response->>'table_id',
 'seat_id',repurchase.response->>'seat_id','seat_number',registration.seat_number,'chips',regain,'registration_id',registration.id));
 CONTINUE;
 END IF;
 SELECT * INTO seat FROM public.table_seats WHERE id=(x->>'seat_id')::uuid AND table_id=p_table
$b4$,
$b5$ OR ((x->>'stack')::numeric=0 AND held>0 AND left_at IS NULL AND joined_at>=rebought)) FOR UPDATE;
 -- Rebought into another chair of this table (above): that chair is the seat.
 IF repurchase.idempotency_key IS NOT NULL THEN
 SELECT * INTO seat FROM public.table_seats WHERE id=(repurchase.response->>'seat_id')::uuid AND table_id=p_table
 AND user_id=(x->>'user_id')::uuid AND seat_number=(repurchase.response->>'seat_number')::integer
 AND left_at IS NULL AND joined_at>=rebought FOR UPDATE;
 IF FOUND THEN
 rechaired:=rechaired||jsonb_build_array(jsonb_build_object('accepted',x,'purchase_key',rekey,'operation',reop,
 'candidate_id',repurchase.response->>'candidate_id','seat_id',seat.id,'seat_number',seat.seat_number,'chips',regain));
 END IF;
 END IF;
 ELSIF item ? 'entry' THEN
$b5$,
$b6$ ||CASE WHEN rebases='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('rebased',rebases) END
 ||CASE WHEN departed='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('departed',departed) END
 ||CASE WHEN rechaired='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('rechaired',rechaired) END) END;
$b6$];
  v_src := v_pre;
  FOR i IN 1..array_length(v_find, 1) LOOP
    v_n := (length(v_src) - length(replace(v_src, v_find[i], ''))) / length(v_find[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'F06_REBUY_RECHAIRED_ANCHOR: anchor % found % times', i, v_n; END IF;
    v_src := replace(v_src, v_find[i], v_repl[i]);
  END LOOP;
  -- Removing every inserted passage is the pre-image byte for byte.
  v_back := v_src;
  FOR i IN REVERSE array_length(v_find, 1)..1 LOOP
    v_n := (length(v_back) - length(replace(v_back, v_repl[i], ''))) / length(v_repl[i]);
    IF v_n <> 1 THEN RAISE EXCEPTION 'F06_REBUY_RECHAIRED_POSTIMAGE: passage % found % times', i, v_n; END IF;
    v_back := replace(v_back, v_repl[i], v_find[i]);
  END LOOP;
  IF v_back IS DISTINCT FROM v_pre THEN
    RAISE EXCEPTION 'F06_REBUY_RECHAIRED_POSTIMAGE: more than the stated passages of f06_movement_prior changed'; END IF;
  IF md5(v_src) <> '0c3f0b7cb997eb761a7295d49df24bc9' THEN
    RAISE EXCEPTION 'F06_REBUY_RECHAIRED_POSTIMAGE: the edited definition is %, not the proved post-image', md5(v_src); END IF;
  EXECUTE v_src;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> 'ab72d64575eae5cf77e6b004dd5ee5f6'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> '0c3f0b7cb997eb761a7295d49df24bc9'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config
     OR (SELECT provolatile FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_vol
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres}' OR v_owner IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'F06_REBUY_RECHAIRED_POSTIMAGE: installed body, owner, ACL or settings differ from the proved post-image';
  END IF;
END
$rechaired$;

-- ---------------------------------------------------------------------------
-- G3 + R: f06_movement_never_dealt_prior
-- ---------------------------------------------------------------------------
DO $never_dealt_addon$
DECLARE
  v_fn  regprocedure := 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure;
  v_pre text; v_src text; v_back text; v_find text[]; v_repl text[]; i integer; v_n integer;
  v_acl text; v_owner text; v_secdef boolean; v_config text[]; v_vol "char";
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig, p.provolatile
    INTO v_pre, v_acl, v_owner, v_secdef, v_config, v_vol
    FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_pre) <> '35dbc3c7dd7b152d8e55892b4af9ae3b'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '2962ab899304584d3ad1ae1d14b3e8dc' THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_ADDON_PREIMAGE_DRIFT: f06_movement_never_dealt_prior is %, read it before re-running', md5(v_pre);
  END IF;
  v_find := ARRAY[
$c1$ arrival public.tournament_seat_move_receipts; arrival_proven boolean;
BEGIN
$c1$,
$c2$ SELECT * INTO fund FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament AND f.registration_id=registration.id ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 entry_proven:=NOT (seat.user_id IS NULL$c2$,
$c3$ AND f.registration_id=registration.id)<>1
$c3$,
$c4$ OR f.observed_at>=fund.observed_at OR f.registration_id IS NULL
$c4$,
$c5$ AND l.from_entity_id=registration.user_id));
$c5$,
$c6$ WHERE later.tournament_id=p_tournament AND later.user_id=seat.user_id AND later.observed_at>fund.observed_at)
$c6$,
$c7$ WHERE later.tournament_id=p_tournament AND later.user_id=seat.user_id AND later.observed_at>arrival.moved_at)
$c7$,
$c8$ END IF;
 IF entry_proven IS NOT TRUE AND rebuy_proven IS NOT TRUE AND arrival_proven IS NOT TRUE THEN
$c8$,
$c9$||CASE WHEN arrival_proven THEN jsonb_build_object('arrival',to_jsonb(arrival)) ELSE '{}'::jsonb END);
$c9$];
  v_repl := ARRAY[
$d1$ arrival public.tournament_seat_move_receipts; arrival_proven boolean;
 -- Add-ons bought on the chair after its entry, rebuy or arrival (2026-10-24).
 tops jsonb; topids uuid[]; toplegids uuid[]; topped uuid[]; toplegs uuid[]; topfirst timestamptz; topafter timestamptz;
 topcur numeric; topgain numeric; topbase public.tournament_participant_funding_receipts;
 topf public.tournament_participant_funding_receipts; topseat public.table_seats; topreg public.tournament_players;
BEGIN
$d1$,
$d2$ SELECT * INTO fund FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament AND f.registration_id=registration.id ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 -- ADD-ONS ON A CHAIR THAT NEVER DEALT ARE CHIP EVIDENCE (2026-10-24). An
 -- entry, rebuy or arrival proven below may since have bought add-ons on
 -- this chair. They are admitted exactly as the dealt proof's purchase loop
 -- admits them: this registration's latest receipts are add-on funding
 -- receipts, each granting the event's add-on chips (or its starting chips),
 -- each recorded with the registration image holding exactly the running
 -- stack, all after the receipt before them. When the rules below refuse the
 -- chair as it stands, they are taken once more on the chair as it stood
 -- before those add-ons (its stack and registration chips less their grants,
 -- the add-on flag clear, the receipt before them as the funding receipt),
 -- with exactly those add-on receipts and their own chip ledger legs set
 -- aside, and an arrival's add-ons all after its move. The roster still
 -- carries the live rows. A chair that needs no add-on is proven as before.
 tops:='[]'; topids:='{}'; toplegids:='{}'; topped:='{}'; toplegs:='{}'; topfirst:=NULL; topafter:=NULL; topbase:=NULL; topcur:=seat.stack;
 FOR topf IN SELECT f.* FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament AND f.registration_id=registration.id
 ORDER BY f.observed_at DESC,f.id DESC LOOP
 IF topf.operation IS DISTINCT FROM 'addon' THEN topbase:=topf; EXIT; END IF;
 topgain:=COALESCE(NULLIF((topf.tournament_snapshot->>'addon_chips')::numeric,0),(topf.tournament_snapshot->>'starting_chips')::numeric,0);
 IF topgain IS NULL OR topgain<=0 OR topf.user_id IS DISTINCT FROM registration.user_id
 OR jsonb_typeof(topf.registration_snapshot->'chips') IS DISTINCT FROM 'number'
 OR (topf.registration_snapshot->>'chips')::numeric IS DISTINCT FROM topcur THEN tops:=NULL; EXIT; END IF;
 tops:=jsonb_build_array(jsonb_build_object('receipt_id',topf.id,'purchase_key',topf.purchase_key,'observed_at',topf.observed_at,
 'chips',topgain,'stack',topcur))||tops;
 topids:=topids||topf.id; IF topf.ledger_id IS NOT NULL THEN toplegids:=toplegids||topf.ledger_id; END IF;
 topfirst:=topf.observed_at; topcur:=topcur-topgain;
 END LOOP;
 IF tops IS NULL OR tops='[]'::jsonb OR topbase.id IS NULL OR topfirst IS NULL OR topcur IS NULL OR topcur<=0
 OR topbase.observed_at>=topfirst THEN tops:='[]'; END IF;
 topseat:=seat; topreg:=registration;
 FOR toppass IN 0..CASE WHEN tops='[]'::jsonb THEN 0 ELSE 1 END LOOP
 IF toppass=1 THEN
 seat.stack:=topcur; registration.chips:=topcur; registration.add_on:=false; fund:=topbase;
 topped:=topids; toplegs:=toplegids; topafter:=topfirst;
 END IF;
 entry_proven:=NOT (seat.user_id IS NULL$d2$,
$d3$ AND f.registration_id=registration.id AND f.id<>ALL(topped))<>1
$d3$,
$d4$ OR f.observed_at>=fund.observed_at OR registration.registered_at IS NULL OR f.observed_at>=registration.registered_at OR f.registration_id IS NULL
$d4$,
$d5$ AND l.from_entity_id=registration.user_id AND l.id<>ALL(toplegs)));
$d5$,
$d6$ WHERE later.tournament_id=p_tournament AND later.user_id=seat.user_id AND later.observed_at>fund.observed_at AND later.id<>ALL(topped))
$d6$,
$d7$ WHERE later.tournament_id=p_tournament AND later.user_id=seat.user_id AND later.observed_at>arrival.moved_at AND later.id<>ALL(topped))
 AND (topafter IS NULL OR topafter>arrival.moved_at)
$d7$,
$d8$ END IF;
 EXIT WHEN entry_proven IS TRUE OR rebuy_proven IS TRUE OR arrival_proven IS TRUE;
 END LOOP;
 seat:=topseat; registration:=topreg;
 IF entry_proven IS NOT TRUE AND rebuy_proven IS NOT TRUE AND arrival_proven IS NOT TRUE THEN
$d8$,
$d9$||CASE WHEN arrival_proven THEN jsonb_build_object('arrival',to_jsonb(arrival)) ELSE '{}'::jsonb END
 ||CASE WHEN topped='{}' THEN '{}'::jsonb ELSE jsonb_build_object('addons',tops) END);
$d9$];
  v_src := v_pre;
  FOR i IN 1..array_length(v_find, 1) LOOP
    v_n := (length(v_src) - length(replace(v_src, v_find[i], ''))) / length(v_find[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'F06_NEVER_DEALT_ADDON_ANCHOR: anchor % found % times', i, v_n; END IF;
    v_src := replace(v_src, v_find[i], v_repl[i]);
  END LOOP;
  -- Removing every inserted passage is the pre-image byte for byte.
  v_back := v_src;
  FOR i IN REVERSE array_length(v_find, 1)..1 LOOP
    v_n := (length(v_back) - length(replace(v_back, v_repl[i], ''))) / length(v_repl[i]);
    IF v_n <> 1 THEN RAISE EXCEPTION 'F06_NEVER_DEALT_ADDON_POSTIMAGE: passage % found % times', i, v_n; END IF;
    v_back := replace(v_back, v_repl[i], v_find[i]);
  END LOOP;
  IF v_back IS DISTINCT FROM v_pre THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_ADDON_POSTIMAGE: more than the stated passages of f06_movement_never_dealt_prior changed'; END IF;
  IF md5(v_src) <> '0ff3bcaef0476a3dc46d6d6931515bb7' THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_ADDON_POSTIMAGE: the edited definition is %, not the proved post-image', md5(v_src); END IF;
  EXECUTE v_src;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> 'dbda1e1dab654980f31706a04f8b6de5'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> '0ff3bcaef0476a3dc46d6d6931515bb7'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config
     OR (SELECT provolatile FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_vol
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres}' OR v_owner IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_ADDON_POSTIMAGE: installed body, owner, ACL or settings differ from the proved post-image';
  END IF;
END
$never_dealt_addon$;

COMMIT;
