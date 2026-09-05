-- Mutual friends answer with the arena name and the arena avatar.
--
-- WHAT WAS WRONG
--
-- `get_mutual_friends` returned `p.username, p.avatar_url` straight off the
-- profile, and the public dossier (/hub/club-arena/profile/:userId) painted
-- both onto its mutual-friend chips.
--
-- Dan, 2026-09-02, the arena identity law: "THE CLUB ARENA SHOULD ALWAYS 100%
-- OF THE TIME USE THE POKER ALIAS AND NOT THE REAL NAME, THE REAL NAME IS USED
-- IN THE WORLD HUB." And 2026-08-23: "IM DAN BEKAVAC ON SOCIAL AND KINGFISH IN
-- THE CLUB ARENA. NOTHING ELSE."
--
-- Raw `username` is not the arena name. The resolver is alias -> username ->
-- display_name (`public.fn_arena_name`, mirrored client-side by
-- `playerDisplayName`), and reading `username` directly skips the alias - the
-- one field that IS the poker name. Measured on production the day this was
-- written:
--
--   1,004 of 1,313 profiles carry an alias that differs from their username,
--         so the chip showed the wrong name for 76% of players;
--   1,020 of 1,313 carry an arena_avatar_url that differs from avatar_url,
--         so the chip showed the player's SOCIAL photo on an arena surface;
--     112 of 1,313 have username = full_name, so for those the chip was
--         printing a legal name onto a Club Arena page.
--
-- The ordering was `ORDER BY p.username` too, so the chips were sorted by a
-- string the player never sees.
--
-- WHY A REPLACEMENT AND NOT A CLIENT FIX
--
-- Every other RPC in this family was corrected the same way (fn_search_players,
-- fn_union_player_directory, fn_list_pending_members - migrations
-- 20260903120000 / 121000 / 121500). The contract keeps its column NAMES so no
-- caller breaks; what changes is that the VALUES are already resolved when they
-- leave the database. A client-side fix would leave the next caller of this RPC
-- holding the same raw columns.
--
-- The signature, return type, volatility, security and search_path are all
-- unchanged, so this is a body swap: RETURNS TABLE(id uuid, username text,
-- avatar_url text) still. `username` now carries the arena name and
-- `avatar_url` the arena portrait, which is what both consumers already assume
-- they are reading.
--
-- SAFETY: read-only function, no data is written or moved. One transaction, so
-- PostgREST reloads its schema cache once (production DDL policy, section 2).

BEGIN;

CREATE OR REPLACE FUNCTION public.get_mutual_friends(p_other_user_id uuid)
RETURNS TABLE(id uuid, username text, avatar_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH mine AS (
    SELECT CASE WHEN user_id = auth.uid() THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND auth.uid() IN (user_id, friend_id)
  ), theirs AS (
    SELECT CASE WHEN user_id = p_other_user_id THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND p_other_user_id IN (user_id, friend_id)
  )
  SELECT
    p.id,
    -- The arena name, never the raw username: alias -> username -> a
    -- display_name that is not simply the real name -> 'Player'.
    public.fn_arena_name(
      p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name
    ) AS username,
    -- The arena portrait. The social photo is the World Hub's; it only stands
    -- in when a player has not chosen arena art yet.
    COALESCE(NULLIF(btrim(p.arena_avatar_url), ''), p.avatar_url) AS avatar_url
  FROM mine JOIN theirs USING (friend_id)
  JOIN public.profiles p ON p.id = mine.friend_id
  WHERE auth.uid() IS NOT NULL AND p_other_user_id IS NOT NULL
  ORDER BY public.fn_arena_name(
    p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name
  ), p.id
  LIMIT 100
$function$;

COMMENT ON FUNCTION public.get_mutual_friends(uuid) IS
  'Mutual friends of the caller and p_other_user_id. The `username` column '
  'carries the ARENA name (fn_arena_name), never the raw username, and '
  '`avatar_url` carries the arena portrait. Club Arena surfaces must never '
  'render a raw profiles.username: it skips the alias, which is the poker '
  'name. See the arena identity law.';

COMMIT;
