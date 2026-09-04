-- What my own migration granted, versus what it said it granted.
--
-- 20260903201348 created club_message_dismissals with RLS on, one
-- read-your-own-row SELECT policy, and a comment claiming "every write goes
-- through the definer below, so there is deliberately no INSERT/UPDATE policy".
-- The POLICIES were right. The GRANTS were never written at all, so Supabase's
-- default privileges on `public` filled them in:
--
--   club_message_dismissals   anon=arwdxtm  authenticated=arwdxtm
--
-- That is SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER, to
-- both roles, on a table whose whole point is that one person cannot touch
-- another person's row. Nothing was exploitable - RLS with no write policy
-- refuses every one of those writes - but the only thing standing between an
-- authenticated client and this table was a policy, where the sibling tables
-- put a missing grant there as well:
--
--   managed_game_command_receipts   postgres, service_role. Nothing else.
--
-- Two locks are the pattern here because one of them is a single ALTER TABLE
-- away from being switched off by accident. Found by listing every RPC the
-- client calls and diffing the grants against their neighbours.
--
-- The same default privileges did it to the two functions, which came out
-- executable by anon while every neighbour is authenticated-only. REVOKE ALL
-- FROM PUBLIC does not remove a grant made directly TO anon, which is why the
-- original REVOKE looked sufficient and was not. Neither function leaks
-- anything - both return not_authenticated when auth.uid() is null - but an
-- endpoint an anonymous caller can reach is attack surface even when it
-- refuses, and these two had no reason to be reachable.

REVOKE ALL ON public.club_message_dismissals FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.club_message_dismissals FROM authenticated;

-- SELECT stays, and stays policy-gated to the caller's own row: it is what
-- makes the read-your-own-row policy reachable, and it is the only thing a
-- client has any business doing with this table directly.
GRANT SELECT ON public.club_message_dismissals TO authenticated;

REVOKE ALL ON FUNCTION public.fn_get_club_entry_message(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_dismiss_club_message(uuid) FROM anon;