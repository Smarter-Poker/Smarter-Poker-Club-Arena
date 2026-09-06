-- ═══════════════════════════════════════════════════════════════════════════
-- fn_probe_table_candidate - a table the synthetic probe may actually open
--
-- Realtime Connections Programme, Phase 6 of 7 ("prove it from outside").
--
-- The probe (`pages/api/cron/table-socket-probe.js` in the World Hub) does what
-- a player does: sign in, open a real WebSocket to a table, wait for the felt
-- to arrive. It needs a table to open, and it may not hardcode one - this
-- database holds 5,547 CLOSED cash tables and 58 running ones, and which is
-- which changes all day. A probe pointed at a table id that closed last week
-- would report an outage every five minutes forever.
--
-- THE FIRST VERSION OF THIS FUNCTION WAS WRONG, and running the probe against
-- production before shipping it is the only reason we know. It returned any
-- busy horse-only table, the probe opened a socket to one, and the engine
-- answered a pre-handshake `HTTP/1.1 403 Forbidden` - which a client can only
-- report as close 1006. The cause was not an outage: `authorizeTableViewer`
-- fails CLOSED on club membership (deliberately - "a stale client result can
-- never grant access to a private club table"), and the service identity is
-- not a member of the clubs that run the public fleet. A probe that picks
-- tables it is not entitled to open does not measure whether a player can hold
-- a table; it measures its own membership, and it would have alarmed every
-- five minutes forever while the platform was perfectly healthy.
--
-- So the candidate is now chosen FOR A SPECIFIC VIEWER and must satisfy every
-- gate that viewer will meet at the upgrade:
--
--   1. IT IS DEALING. `TableStateHub.subscribe()` sends a SNAPSHOT immediately
--      if the room has published one, and otherwise holds the subscriber until
--      the next publish. A running-but-idle table would leave the probe
--      waiting until its timeout and reporting "the socket opened and no felt
--      arrived" - a real fault signature - for a table that is merely quiet.
--      Requiring recent hands makes the absence of a snapshot mean what the
--      probe says it means.
--
--   2. THE VIEWER IS A MEMBER OF ITS CLUB, with the same statuses
--      `authorizeTableViewer` accepts ('active', 'approved'). Same rule as a
--      person: a synthetic player is still a player.
--
--   3. THE TABLE ADMITS OBSERVERS. `restrict_observers` is a seats-only room
--      (Dan, 2026-08-25) and refuses a watcher with the same pre-handshake
--      403. The probe never takes a seat, so a seats-only table is not a table
--      it can prove anything about.
--
--   4. NO HUMAN IS SITTING AT IT. CLAUDE.md 10.5 (HORSES ARE PLAYERS) forbids
--      using `is_horse` to deny horses anything; it explicitly permits reading
--      the flag to IDENTIFY. Nothing is denied here. The probe takes no seat,
--      moves no chips and plays no hand - it subscribes as an observer and
--      leaves. Preferring a table with no human on it is a courtesy to the
--      human (the probe's socket never counts against their room's subscriber
--      budget and never appears in their presence), not a statement about
--      horses. A horse's table is not a lesser table; it is the one where an
--      observer costs nobody anything.
--
-- It returns ONE ROW AT RANDOM among the qualifying tables, not the busiest.
-- Always probing the busiest would let one healthy table mask a fleet where
-- every other room is broken, and would make one sick table alarm every five
-- minutes forever. Random coverage means a single bad table shows up as
-- intermittent - which is the truth - and over a day the probe visits the
-- fleet.
--
-- Zero rows is a MEANINGFUL answer, not an error: no table the probe may open
-- has dealt a hand in ten minutes, on a platform that deals ~221,000 a day.
--
-- Cost: the 10-minute window rides `idx_hand_history_created` (created_at
-- DESC) as a range scan, so this does not read the 3.6 GB table.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_probe_table_candidate(p_viewer uuid)
RETURNS TABLE (table_id uuid, table_name text, club_id uuid, hands_10m bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH viewer_clubs AS (
    SELECT m.club_id
    FROM club_members m
    WHERE m.user_id = p_viewer
      AND m.status IN ('active', 'approved')
  ),
  recent AS (
    SELECT h.table_id, count(*) AS hands_10m
    FROM hand_history h
    WHERE h.created_at > now() - interval '10 minutes'
    GROUP BY h.table_id
    HAVING count(*) >= 3
  ),
  seated_humans AS (
    SELECT DISTINCT s.table_id
    FROM table_seats s
    JOIN profiles p ON p.id = s.user_id
    WHERE s.left_at IS NULL
      AND NOT COALESCE(p.is_horse, false)
  )
  SELECT t.id, t.name, t.club_id, r.hands_10m
  FROM tables t
  JOIN recent r ON r.table_id = t.id
  JOIN viewer_clubs vc ON vc.club_id = t.club_id
  WHERE t.status = 'running'
    AND t.tournament_id IS NULL
    AND COALESCE(t.is_deleted, false) = false
    AND COALESCE(t.restrict_observers, false) = false
    AND NOT EXISTS (SELECT 1 FROM seated_humans sh WHERE sh.table_id = t.id)
  ORDER BY random()
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.fn_probe_table_candidate(uuid) IS
  'Realtime Phase 6: one running, observer-friendly, human-free cash table in a club the given viewer belongs to, that has dealt at least 3 hands in the last 10 minutes, chosen at random. Every condition mirrors a gate the viewer will meet at the WebSocket upgrade, so a zero result means "nothing to probe" and never "the probe is not allowed in". Used by the table-socket-probe.';

REVOKE ALL ON FUNCTION public.fn_probe_table_candidate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_probe_table_candidate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_probe_table_candidate(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_probe_table_candidate(uuid) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- The probe has to BE a player, because the gate it must pass is the one every
-- player passes.
--
-- `authorizeTableViewer` fails closed on club membership and has no god-role
-- bypass, which is correct and must stay correct - weakening a viewer gate for
-- a monitor's convenience is the shape of bug this whole programme exists to
-- stop. So the platform's own service identity (`daniel@smarter.poker`, the
-- account Dan designated for exactly this on 2026-09-04: "USE THE OTHER 'GOD
-- MODE ADMIN ACCOUNT' ... KEEP MY ACCOUNT CLEAN") joins the two clubs that run
-- the public cash fleet, as an ordinary player.
--
-- What this row is and is not:
--   • chip_balance 0, so it can never buy in even if something tried;
--   • it never takes a seat - the probe subscribes as an observer and the law
--     test pins that it calls no endpoint which moves a seat, a hand or a chip;
--   • both clubs are Dan's own, and both already admit observers;
--   • it is one row per club and dropping it is one DELETE.
--
-- Two clubs rather than one on purpose: if either club's tables all close, the
-- probe still has somewhere to look, and a probe with nowhere to look reports
-- the fleet as not dealing.
--
-- THE `set_config` BELOW IS LOAD-BEARING AND THE FIRST DRAFT DID NOT HAVE IT.
-- `club_members` carries 34 triggers, and `trg_club_members_require_explicit_join`
-- refuses ANY insert that does not declare where the membership came from:
--
--     MEMBERSHIP_REQUIRES_JOIN: Club Members Can Only Be Added Through Join A Club
--
-- so this migration would have aborted on apply, taking the function above with
-- it. Found by probing it inside a self-aborting transaction (CLAUDE.md 11.5)
-- rather than by shipping it and watching. `fn_join_club` sets exactly this
-- value around the real join; the platform's own join path is what we are
-- imitating, so we imitate all of it - the column list below is the one
-- `fn_join_club_membership_impl` writes, down to `rank_level` and
-- `orange_ball_status`, so the row is indistinguishable from a player who
-- joined through the UI. `fn_join_club` itself cannot be called here: it reads
-- `auth.uid()`, and a migration has no session user.
--
-- The other 33 triggers were checked and pass: `fn_membership_approval_gate`
-- returns early for any caller that is not `authenticated`/`anon`;
-- `fn_ca_reject_automated_user_club_row` only fires for a horse or `is_bot`;
-- the four-club limit is not reached (this is the account's second and third);
-- and `zz_freeze_guard` carries an explicit carve-out - "a membership row
-- carrying no chips is identity, not money. This table, INSERT only, zero
-- balance" - so a `:55` maintenance break cannot abort this apply.
-- ───────────────────────────────────────────────────────────────────────────
SELECT set_config('app.club_membership_source', 'join_club', true);

INSERT INTO public.club_members
  (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance, is_bot, notes)
SELECT c.id,
       u.id,
       'player',
       'active',
       'bronze',
       0,
       'cold',
       0,
       false,
       'Platform service identity. Member so the Realtime phase-6 table-socket probe can open an observer socket like any player; holds no chips and never takes a seat.'
FROM public.clubs c
CROSS JOIN auth.users u
WHERE u.email = 'daniel@smarter.poker'
  AND c.id IN (
    'fade0000-0000-0000-0000-000000000001',  -- Midway Union
    '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'   -- Deep Stack Society
  )
ON CONFLICT (club_id, user_id) DO NOTHING;

SELECT set_config('app.club_membership_source', '', true);

-- The apply must not report success if the probe still cannot see a table.
DO $assert$
DECLARE v_clubs int;
BEGIN
  SELECT count(*) INTO v_clubs
  FROM public.club_members m
  JOIN auth.users u ON u.id = m.user_id
  WHERE u.email = 'daniel@smarter.poker'
    AND m.status IN ('active', 'approved')
    AND m.club_id IN (
      'fade0000-0000-0000-0000-000000000001',
      '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
    );
  IF v_clubs <> 2 THEN
    RAISE EXCEPTION
      'The probe identity is a member of % of the 2 fleet clubs. It would be blind, and a blind probe reports its own blindness as an outage.',
      v_clubs;
  END IF;
END
$assert$;

COMMIT;
