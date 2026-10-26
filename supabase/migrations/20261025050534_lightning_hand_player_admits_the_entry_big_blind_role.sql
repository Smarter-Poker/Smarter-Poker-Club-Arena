-- 20261025050534_lightning_hand_player_admits_the_entry_big_blind_role.sql
-- @install-window: daily-maintenance
-- @live-proof: (SELECT position('''entry_bb''' IN pg_get_constraintdef(c.oid)) > 0 FROM pg_constraint c WHERE c.conrelid = 'public.lightning_hand_player'::regclass AND c.conname = 'lightning_hand_player_blind_role_check')
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-24: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST." When holding a
-- newcomer would leave a Lightning pass no hand at all, the newcomer is dealt
-- in and posts a LIVE ENTRY BIG BLIND from their seat (20261025050528). The
-- barrier records that on the participant row as blind_role 'entry_bb'.
--
-- lightning_hand_player_blind_role_check admits
-- none / sb / bb / both / dead_sb / straddle and nothing else, so an
-- 'entry_bb' row would be a check_violation, which the barrier treats as an
-- impossible state and FREEZES the Cluster. This widens the list by exactly
-- that one value and changes nothing else.
--
-- WHY THE DAILY WINDOW (CLAUDE.md section 2, rules 9 and 10). Dropping and
-- adding a CHECK takes ACCESS EXCLUSIVE on lightning_hand_player, which every
-- Lightning formation inserts into and every fold updates (1.4M rows, 473 MB,
-- read 2026-10-24). It is one ALTER TABLE, so the lock is taken once and held
-- for milliseconds, inside the 04:00 freeze, with the installer's 1 s
-- lock_timeout. NOT VALID: re-scanning 473 MB under that lock is what the
-- window budget forbids, and every existing row already satisfies the wider
-- list (it is a superset of the old one), so nothing is left unchecked that
-- the old constraint checked. New writes are checked at once.
--
-- ORDER. Until this lands, the entry big blind gate that 20261025050528
-- inlines into the plan and the barrier reads this constraint and stays
-- closed, so no plan or barrier emits 'entry_bb' and nothing can trip it.
-- The guard below refuses a drifted constraint instead of replacing someone
-- else's definition.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $guard$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO d
    FROM pg_constraint c
   WHERE c.conrelid = 'public.lightning_hand_player'::regclass
     AND c.conname = 'lightning_hand_player_blind_role_check';
  IF d IS DISTINCT FROM 'CHECK (((blind_role IS NULL) OR (blind_role = ANY (ARRAY[''none''::text, ''sb''::text, ''bb''::text, ''both''::text, ''dead_sb''::text, ''straddle''::text]))))' THEN
    RAISE EXCEPTION 'lightning_hand_player_blind_role_check changed; requalify the entry big blind role: %', d;
  END IF;
END
$guard$;

ALTER TABLE public.lightning_hand_player
  DROP CONSTRAINT lightning_hand_player_blind_role_check,
  ADD CONSTRAINT lightning_hand_player_blind_role_check
    CHECK (blind_role IS NULL OR blind_role = ANY (ARRAY['none', 'sb', 'bb', 'both', 'dead_sb', 'straddle', 'entry_bb']))
    NOT VALID;

COMMIT;
