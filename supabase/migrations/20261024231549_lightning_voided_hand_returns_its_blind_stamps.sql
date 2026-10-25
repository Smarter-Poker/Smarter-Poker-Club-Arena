-- @live-proof: (SELECT position('A VOIDED HAND RETURNS ITS BLIND STAMPS' IN pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure))>0)
-- 20261024231549_lightning_voided_hand_returns_its_blind_stamps.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-24: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST." The live matcher
-- (20261024195059) decides "newcomer" and the big-blind order from
-- lightning_pool_slot.last_bb_at (NULL = never been the big blind, ranked
-- first). fn_lightning_form_hand stamps last_bb_at, last_sb_at,
-- last_button_at, hands_since_bb and hands_since_sb on every slot of a hand
-- the moment it FORMS.
--
-- A formed hand can be voided before it is ever dealt (begin_dealing's own
-- refusal, deal_failed, host_lease_not_held, the reaper, a drain). The
-- 20261007222717 remediation already gives such a hand's BLIND LEDGER counts
-- back in fn_lightning_instance_releases_its_reservations, because "a credit
-- it kept made fn_lightning_blind_order skip its player for a blind they
-- never paid". The pool-slot stamps were never given back, and they are the
-- keys the plan actually ranks by:
--
--   - the hand's big blind is recorded as having had the big blind
--     (last_bb_at = formation time) without posting one, so they drop to the
--     back of the rotation and skip a big blind everyone else pays;
--   - if they were NEW, last_bb_at is no longer NULL, so they stop being a
--     newcomer without ever having been dealt in the big blind, and their
--     first real hand can be the small blind.
--
-- Production, read 2026-10-24: 24 Lightning hands voided before dealing in
-- the last 24 hours (26 in 7 days).
--
-- THE FIX, in the same door the ledger reversal uses (every abandon path
-- crosses it, exactly once, only on the transition into a terminal state):
-- for each slot of a hand abandoned before dealing, the stamps are recomputed
-- from that slot's own DEALT hands (instance started_at IS NOT NULL),
-- excluding the voided hand:
--
--   - the voided hand's big blind gets last_bb_at back as the formation time
--     of its last dealt big blind, or NULL if it never had one (a newcomer is
--     a newcomer again), and hands_since_bb as the dealt hands since then;
--   - the same for the small blind (last_sb_at, hands_since_sb) and the
--     button (last_button_at);
--   - every other slot's hands_since_bb / hands_since_sb, which formation
--     incremented, is decremented (floored at zero).
--
-- No slot of a voided hand can have been formed into a later hand between
-- formation and the void: the committed reservation bars it from matching
-- until this very trigger releases it. Horses are players (CLAUDE.md 10.5):
-- nothing here reads a horse marker. No money, seat or ledger row is written.
--
-- Applied as an md5-guarded text replacement of the live definition (the
-- house pattern from 20261023230001, 20261024073506 and 20261024195059), so a
-- drifted source aborts instead of overwriting someone else's change.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $do$
DECLARE
  sig  CONSTANT text := 'public.fn_lightning_instance_releases_its_reservations()';
  want CONSTANT text := '232f8d4784738e52d18e9ecefb2cd567';
  tail CONSTANT text := E'  END IF;\n  RETURN NULL;\nEND\n$function$';
  s text;
  n text;
BEGIN
  s := pg_get_functiondef(sig::regprocedure);
  IF position('A VOIDED HAND RETURNS ITS BLIND STAMPS' IN s) > 0 THEN
    RAISE NOTICE 'already installed: %', sig;
    RETURN;
  END IF;
  IF md5(s) IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'Lightning source changed; requalify the voided-hand blind stamps before installation: %', sig;
  END IF;
  IF (length(s) - length(replace(s, tail, ''))) / length(tail) <> 1 THEN
    RAISE EXCEPTION 'Lightning release trigger tail anchor changed';
  END IF;

  n := replace(s, tail, $blk$  END IF;
  -- A VOIDED HAND RETURNS ITS BLIND STAMPS (2026-10-24). The ledger counts
  -- above are not what the plan ranks by: fn_lightning_blind_order and the
  -- newcomer rule read lightning_pool_slot.last_bb_at (NULLS FIRST), and
  -- fn_lightning_form_hand stamped it at formation. A hand that never dealt
  -- gives those stamps back too, recomputed from the slot's own dealt hands,
  -- so its big blind is not skipped in the rotation and a newcomer stays a
  -- newcomer ("NEW PLAYERS SHOULD ALWAYS BE BB FIRST", Dan 2026-10-24).
  IF NEW.state = 'abandoned' AND NEW.started_at IS NULL AND NEW.hand_id IS NOT NULL THEN
    UPDATE public.lightning_pool_slot sl
       SET last_bb_at     = CASE WHEN r.was_bb  THEN r.prev_bb_at  ELSE sl.last_bb_at END,
           last_sb_at     = CASE WHEN r.was_sb  THEN r.prev_sb_at  ELSE sl.last_sb_at END,
           last_button_at = CASE WHEN r.was_btn THEN r.prev_btn_at ELSE sl.last_button_at END,
           hands_since_bb = CASE WHEN r.was_bb THEN r.dealt_since_bb
                                 ELSE GREATEST(sl.hands_since_bb - 1, 0) END,
           hands_since_sb = CASE WHEN r.was_sb THEN r.dealt_since_sb
                                 ELSE GREATEST(sl.hands_since_sb - 1, 0) END,
           updated_at     = clock_timestamp()
      FROM (SELECT hp.pool_slot_id,
                   coalesce(hp.blind_role, 'none') = 'bb' AS was_bb,
                   coalesce(hp.blind_role, 'none') = 'sb' AS was_sb,
                   coalesce(hp."position", '') = 'btn'    AS was_btn,
                   prev.bb_at  AS prev_bb_at,
                   prev.sb_at  AS prev_sb_at,
                   prev.btn_at AS prev_btn_at,
                   cnt.since_bb AS dealt_since_bb,
                   cnt.since_sb AS dealt_since_sb
              FROM public.lightning_hand_player hp
              CROSS JOIN LATERAL (
                SELECT max(d.formed_at) FILTER (WHERE d.blind_role = 'bb')  AS bb_at,
                       max(d.formed_at) FILTER (WHERE d.blind_role = 'sb')  AS sb_at,
                       max(d.formed_at) FILTER (WHERE d."position" = 'btn') AS btn_at
                  FROM (SELECT x.blind_role, x."position", h.formed_at
                          FROM public.lightning_hand_player x
                          JOIN public.lightning_hand h ON h.hand_id = x.hand_id
                          JOIN public.lightning_instance i ON i.hand_id = x.hand_id
                         WHERE x.pool_slot_id = hp.pool_slot_id
                           AND x.hand_id <> NEW.hand_id
                           AND i.started_at IS NOT NULL) d) prev
              CROSS JOIN LATERAL (
                SELECT (count(*) FILTER (WHERE prev.bb_at IS NULL OR d.formed_at > prev.bb_at))::integer AS since_bb,
                       (count(*) FILTER (WHERE prev.sb_at IS NULL OR d.formed_at > prev.sb_at))::integer AS since_sb
                  FROM (SELECT h.formed_at
                          FROM public.lightning_hand_player x
                          JOIN public.lightning_hand h ON h.hand_id = x.hand_id
                          JOIN public.lightning_instance i ON i.hand_id = x.hand_id
                         WHERE x.pool_slot_id = hp.pool_slot_id
                           AND x.hand_id <> NEW.hand_id
                           AND i.started_at IS NOT NULL) d) cnt
             WHERE hp.hand_id = NEW.hand_id AND hp.pool_slot_id IS NOT NULL) r
     WHERE sl.id = r.pool_slot_id;
  END IF;
  RETURN NULL;
END
$function$$blk$);

  IF n = s OR position('A VOIDED HAND RETURNS ITS BLIND STAMPS' IN n) = 0 THEN
    RAISE EXCEPTION 'Lightning voided-hand blind stamps replacement did not take';
  END IF;
  EXECUTE n;
END
$do$;

COMMIT;
