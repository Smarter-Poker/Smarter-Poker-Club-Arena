-- 20260905195426_user_table_settings_gain_the_all_in_squeeze_toggle.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-09-05: the board "river squeeze" becomes a VIP perk - "THIS SHOULD
-- BE A VIP GATED PERK AND 'TURNED ON' BY DEFAULT. IF A NONE VIP MEMBER TRIES
-- TO TURN IT ON THEY SHOULD BE INSTRUCTED THAT THEY NEED A VIP CARD TO USE
-- THIS FEATURE." An all-in VIP with this on squeezes each run-out card open
-- themselves (drag on desktop, touch on mobile); everyone else at the table
-- sees the ordinary reveal.
--
-- DEFAULT TRUE, for everyone, VIP or not. The perk is "turned on by default"
-- for a VIP, and a member who becomes a VIP tomorrow should find it on
-- without visiting settings. For a non-VIP the stored true is inert: the
-- client resolves the EFFECTIVE value as (stored AND vip), shows the switch
-- off, and answers an attempt to switch it on with the VIP upsell instead of
-- a write. So this column never gates anything by itself - the VIP check is
-- the gate, this is the player's preference underneath it.
--
-- WHAT IT DOES NOT DO: it changes nothing about the server's run-out pacing,
-- which is the same for every seat (CLAUDE.md 10.5: timing is part of the
-- treatment), and it is never broadcast - a viewer's eligibility is computed
-- on their own client from their own seat, VIP status and this row.
--
-- ONE transaction: every DDL statement fires Supabase's schema-cache reload,
-- ~28s on this database, and loose statements mean one reload each.

BEGIN;

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS all_in_squeeze boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_table_settings.all_in_squeeze IS
  'VIP perk (Dan 2026-09-05): when the player is all-in, they squeeze each run-out card open themselves. '
  'Preference only; the client applies it as (all_in_squeeze AND active VIP). Never broadcast.';

COMMIT;
