-- ═══════════════════════════════════════════════════════════════════════════
--  A TOURNAMENT HOST CAN TURN RABBIT HUNT OFF
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Rabbit hunt is gated on `tables.allow_rabbit_hunt`. Cash tables set that
-- column explicitly at creation, so a cash host controls it. Tournament tables
-- are inserted by TournamentManagerBase and never set it at all, so every MTT,
-- Spin and Heads Up table inherits the column default.
--
-- The feature is therefore ON for every tournament in existence — which is what
-- Dan asked for ("the rabbit hunt feature is missing from all cash game, mtt,
-- spins and heads up") — but it is on by OMISSION, not by decision, and there
-- is no way for a host to turn it off. A setting that cannot be changed is not
-- a setting.
--
-- This gives tournaments the same switch cash games have. Default TRUE so
-- behaviour is identical for every tournament that exists today.
--
-- ROLLBACK
--   ALTER TABLE public.tournaments DROP COLUMN IF EXISTS allow_rabbit_hunt;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS allow_rabbit_hunt boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tournaments.allow_rabbit_hunt IS
  'Host toggle. Copied onto each tournament table row at creation; the engine reads tables.allow_rabbit_hunt.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tournaments' AND column_name='allow_rabbit_hunt'
  ) THEN
    RAISE EXCEPTION 'tournaments.allow_rabbit_hunt was not created';
  END IF;

  -- Every existing tournament must keep the behaviour it has today.
  IF EXISTS (SELECT 1 FROM public.tournaments WHERE allow_rabbit_hunt IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'an existing tournament did not default to rabbit hunt enabled';
  END IF;
END $$;
