-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192208; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS mystery_bounty_activation text NOT NULL DEFAULT 'at_the_money',
  ADD COLUMN IF NOT EXISTS mystery_bounty_activation_value numeric,
  ADD COLUMN IF NOT EXISTS mystery_bounty_profile text NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS mystery_bounty_top_percent numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS mystery_bounty_regular_pool_percent numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS mystery_bounty_pool_percent numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS mystery_bounty_stage text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS mystery_bounty_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS mystery_bounty_activated_players int,
  ADD COLUMN IF NOT EXISTS mystery_bounty_pool_cents bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_mystery_activation_chk') THEN
    ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_mystery_activation_chk
      CHECK (mystery_bounty_activation IN ('at_the_money','percent_field','player_count'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_mystery_profile_chk') THEN
    ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_mystery_profile_chk
      CHECK (mystery_bounty_profile IN ('balanced','classic','jackpot'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_mystery_stage_chk') THEN
    ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_mystery_stage_chk
      CHECK (mystery_bounty_stage IN ('pending','active','complete'));
  END IF;
END $$;

COMMENT ON COLUMN public.tournaments.mystery_bounty_pool_percent IS
  'Percent of bounty_pool reserved for mystery chests. The remainder (mystery_bounty_regular_pool_percent) funds ordinary knockouts before activation.';
COMMENT ON COLUMN public.tournaments.mystery_bounty_pool_cents IS
  'The mystery half of the bounty pool in INTEGER CENTS, frozen at activation. Every chest amount sums to exactly this.';

CREATE TABLE IF NOT EXISTS public.tournament_bounty_chests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  seq int NOT NULL,
  tier text NOT NULL CHECK (tier IN ('jackpot','mega','major','large','medium','small','base_plus','base')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','revealed','paid','void')),
  award_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_bounty_chests_next_available
  ON public.tournament_bounty_chests (tournament_id, seq)
  WHERE status = 'available';

CREATE TABLE IF NOT EXISTS public.tournament_bounty_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  chest_id uuid NOT NULL REFERENCES public.tournament_bounty_chests(id),
  table_id uuid NULL,
  hand_id text NULL,
  eliminated_user_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  tier text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','revealed','paid','completed')),
  op_id uuid NOT NULL UNIQUE,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  revealed_at timestamptz NULL,
  paid_at timestamptz NULL,
  reveal_deadline_at timestamptz NULL,
  UNIQUE (tournament_id, eliminated_user_id)
);

CREATE INDEX IF NOT EXISTS idx_bounty_awards_tournament ON public.tournament_bounty_awards (tournament_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_bounty_awards_table_open ON public.tournament_bounty_awards (tournament_id, table_id, reserved_at)
  WHERE status IN ('reserved','revealed');

CREATE TABLE IF NOT EXISTS public.tournament_bounty_award_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES public.tournament_bounty_awards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  is_designated_revealer boolean NOT NULL DEFAULT false,
  paid_at timestamptz NULL,
  UNIQUE (award_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bounty_recipients_user ON public.tournament_bounty_award_recipients (user_id);

ALTER TABLE public.tournament_bounty_chests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_bounty_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_bounty_award_recipients ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tournament_bounty_chests FROM anon, authenticated;
REVOKE ALL ON public.tournament_bounty_awards FROM anon, authenticated;
REVOKE ALL ON public.tournament_bounty_award_recipients FROM anon, authenticated;
