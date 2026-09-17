-- ═══════════════════════════════════════════════════════════════════════════
--  ANYONE WITH DIAMONDS MAY PLAY
--
--  Dan, 2026-09-09, asked who is allowed into the Diamond Games:
--  "ANYONE WHO HAS DIAMONDS IN THERE ACCOUNT, INCLUDING HORSES."
--
--  Until now all three games took purchased diamonds only. That guard was
--  put in to honour the 2026-09-05 ruling that nothing ever earns chips: an
--  earned diamond could not become a chip. The consequence, measured on this
--  database the day this migration was written, was that the games were open
--  and unplayable. 1,199 profiles hold 3,529,754 diamonds between them. The
--  store has never taken a payment: zero iap_events against ten configured
--  products. Three legacy purchase rows became two lots held by ONE account,
--  worth 200 diamonds. So the audience for three finished games was one
--  player with two spins in them, and the games had recorded, between them,
--  zero rounds ever.
--
--  This opens them. An earned diamond may now be played, and 80 percent of
--  what the games take comes back as chips. That is the ruling, and it is
--  the ruling that matters: the guard was mine, not his.
--
--  WHAT DOES NOT CHANGE. Every other bound stays exactly where it was. The
--  games still never pay out more than they have taken in (paid + reserved
--  <= minted + allowance, made by arithmetic in the per-round cap, not by
--  hope). The house still keeps 20 percent. The per-player day caps and the
--  pause between rounds stay. The platform freeze and the payout freezes
--  still close the door. What changes is one boolean per host per game.
--
--  HORSES. Nothing here mentions them, because nothing has to: a horse is a
--  player (CLAUDE.md 10.5). fn_ca_is_fixture_account and fn_ca_is_cert_account
--  already exclude horses by name, so a horse with diamonds was never
--  certification equipment and is admitted by the same door as anyone else.
--  There is no is_horse filter in this file and there must never be one.
--
--  The config history triggers record these as ordinary edits, so the
--  operator console shows who changed what and when, as it would for any
--  change an owner made by hand.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- The wheel, on every host that has a config.
UPDATE public.wheel_configs
   SET purchased_only = false,
       updated_at = now()
 WHERE purchased_only;

-- Plinko and Crash, likewise.
UPDATE public.diamond_game_configs
   SET purchased_only = false,
       updated_at = now()
 WHERE purchased_only;

-- The door is open or this migration did not do its job.
DO $$
DECLARE
  v_closed integer;
BEGIN
  SELECT (SELECT count(*) FROM public.wheel_configs WHERE purchased_only)
       + (SELECT count(*) FROM public.diamond_game_configs WHERE purchased_only)
    INTO v_closed;
  IF v_closed <> 0 THEN
    RAISE EXCEPTION 'anyone_with_diamonds_may_play: % config(s) still take purchased diamonds only', v_closed;
  END IF;
END $$;

COMMIT;
