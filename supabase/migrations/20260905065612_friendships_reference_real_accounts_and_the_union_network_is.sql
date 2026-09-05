-- 20260905065612_friendships_reference_real_accounts_and_the_union_network_is.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- TWO CHANGES, ONE TRANSACTION. They are unrelated in subject and ship in the
-- same pull request; the production DDL policy (club-arena CLAUDE.md section 2)
-- says to batch, because every DDL statement fires Supabase's
-- `pgrst_ddl_watch` and one schema-cache reload on this database takes ~28
-- seconds. Two migrations here would be two reloads for no benefit.
--
-- ---------------------------------------------------------------------------
-- 1. A FRIENDSHIP POINTS AT AN ACCOUNT THAT EXISTS
-- ---------------------------------------------------------------------------
--
-- `public.friendships` had NO foreign key on either `user_id` or `friend_id` -
-- it is the only social table in this schema without one. `social_connections`,
-- `union_admins`, `page_followers` and thirty others all carry
-- `REFERENCES auth.users(id) ON DELETE CASCADE`; friendships never got it, so
-- every account deletion left its edges behind.
--
-- Measured on production 2026-09-05: 3,990 of 17,440 friendship rows (23%)
-- referenced a uuid with no `auth.users` row AND no `profiles` row. Those ids
-- appear nowhere else on the platform - zero `club_members`, zero
-- `table_seats`, zero `chip_transactions`, zero `tournament_players` - so they
-- are not horses (HORSES ARE PLAYERS, 10.5: a horse has a profile, a club
-- membership and a seat; these have none of the three). They are references to
-- accounts that no longer exist.
--
-- What a player saw: /friends renders `resolveSocialProfile` -> null as
-- "Player Profile Unavailable / Connection Record Only" and counts them into a
-- banner. Dan's own account showed "3743 Relationships Need Profile Repair"
-- above a list of rows that can never resolve, each with Message and Challenge
-- suppressed and only Remove offered - one at a time, by hand, forever.
-- 37 live accounts carry at least one.
--
-- The delete is safe by construction: the row's counterparty does not exist,
-- so there is no person on the other side of the relationship to lose one.
-- Probed first inside a transaction that aborted itself (11.5): before 17,440,
-- dangling 3,990, deleted 3,990, after 13,450, still dangling 0.
--
-- The foreign keys are the part that makes it stay fixed. Without them the
-- next account deletion starts the pile again.
--
-- ---------------------------------------------------------------------------
-- 2. THE UNION NETWORK IS ONE ALLOWLIST, ASKED FOR BY NAME
-- ---------------------------------------------------------------------------
--
-- Dan, 2026-09-05: "(AND THIS PAGE SHOULD BE HIDDEN TO EVERYONE EXECPT ME:
-- https://smarter.poker/hub/club-arena/unions)".
--
-- The allowlist already exists. `public.union_creators` was created on
-- 2026-09-04 for "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL ACCOUNTS
-- EXCEPT FOR MINE" and holds exactly one row, Dan's. Rather than invent a
-- second list that can drift out of step with the first, this adds a second
-- INTENTION-REVEALING NAME over the same table: creating a union and operating
-- the union directory are the same audience, and if Dan ever adds a second
-- operator they must get both or neither.
--
-- `fn_can_i_operate_the_union_network()` takes no argument on purpose, exactly
-- like `fn_can_i_create_a_union()`: the answer is about `auth.uid()`, so a
-- browser cannot ask about somebody else.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not touch the
-- `unions_public_browse` RLS policy. That policy (`is_public IS NOT FALSE`,
-- granted to authenticated) is read by TablePage, CashierPage, ChipMintModal,
-- BadBeatJackpotPage, HomePage, UnionGamesPage, SettlementPage and the
-- tournament Unions tab - money-adjacent surfaces that need a union's name and
-- owner. Narrowing it to hide one directory page would break those, a far
-- larger blast radius than the request. Dan asked for the PAGE to be hidden;
-- the route guard and the navigation entries are where a page lives, and this
-- function is the server's answer that both of them read.

BEGIN;

-- == 1. Friendships =========================================================

-- Assert the board has not moved since the probe. If some other process has
-- already cleaned these up, or the number has grown by an order of magnitude,
-- this aborts rather than deleting something nobody measured.
DO $$
DECLARE v_dangling bigint;
BEGIN
  SELECT count(*) INTO v_dangling
    FROM public.friendships f
   WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = f.user_id)
      OR NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = f.friend_id);
  IF v_dangling > 6000 THEN
    RAISE EXCEPTION 'friendships cleanup: % dangling rows, far beyond the 3,990 measured on 2026-09-05. Re-measure before deleting.', v_dangling;
  END IF;
END $$;

DELETE FROM public.friendships f
 WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = f.user_id)
    OR NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = f.friend_id);

-- The reason it can never come back. Matches the convention every other social
-- table here already uses.
ALTER TABLE public.friendships
  ADD CONSTRAINT friendships_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.friendships
  ADD CONSTRAINT friendships_friend_id_fkey
  FOREIGN KEY (friend_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- An account must stay deletable: a foreign key check with no usable index on
-- the child is a sequential scan of it, and a PARTIAL index cannot answer one
-- because the check must find the rows the predicate hides. Both columns are
-- already indexed (idx_friendships_user, idx_friendships_friend). Asserted
-- rather than assumed.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c.col, ', ') INTO v_missing
    FROM (VALUES ('user_id'), ('friend_id')) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
      WHERE n.nspname = 'public' AND t.relname = 'friendships'
        AND a.attname = c.col AND i.indpred IS NULL
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'friendships: no leading, non-partial index for %; an account deletion would sequentially scan the table', v_missing;
  END IF;
END $$;

DO $$
DECLARE v_left bigint;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.friendships f
   WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = f.user_id)
      OR NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = f.friend_id);
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'friendships: % dangling rows survived the cleanup', v_left;
  END IF;
END $$;

COMMENT ON CONSTRAINT friendships_user_id_fkey ON public.friendships IS
  'Added 2026-09-05. Without it, deleting an account left its friendship edges behind; 3,990 such rows had accumulated and rendered as "Player Profile Unavailable" on /friends.';

-- == 2. The union network allowlist, asked for by name ======================

CREATE OR REPLACE FUNCTION public.fn_can_i_operate_the_union_network()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Same allowlist as fn_can_i_create_a_union: one table, so the directory and
  -- the create door can never disagree about who operates the union network.
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.union_creators uc WHERE uc.user_id = auth.uid());
$function$;

COMMENT ON FUNCTION public.fn_can_i_operate_the_union_network() IS
  'Dan 2026-09-05: the /unions directory is hidden to everyone except him. Reads public.union_creators, the same allowlist fn_can_i_create_a_union reads. Takes no argument so a browser cannot ask about another account.';

REVOKE ALL ON FUNCTION public.fn_can_i_operate_the_union_network() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_i_operate_the_union_network() TO authenticated, service_role;

-- The answer must be yes for the one account on the list and no for an account
-- that is not on it.
DO $$
DECLARE v_prev text := current_setting('request.jwt.claims', true); v_dan boolean; v_other boolean;
BEGIN
  PERFORM set_config('request.jwt.claims',
    '{"sub":"47965354-0e56-43ef-931c-ddaab82af765","role":"authenticated"}', true);
  SELECT public.fn_can_i_operate_the_union_network() INTO v_dan;

  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}', true);
  SELECT public.fn_can_i_operate_the_union_network() INTO v_other;

  PERFORM set_config('request.jwt.claims', coalesce(v_prev, ''), true);

  IF v_dan IS NOT TRUE THEN
    RAISE EXCEPTION 'union network gate: the allowlisted founder was refused';
  END IF;
  IF v_other IS NOT FALSE THEN
    RAISE EXCEPTION 'union network gate: an account that is not on the allowlist was admitted';
  END IF;
END $$;

COMMIT;
