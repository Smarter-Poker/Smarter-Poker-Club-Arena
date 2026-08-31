-- Create Auth-linked ledgers in their own short transaction. Keeping these FK
-- locks out of the later trigger migration prevents a live tournament write
-- from deadlocking on tournament_players -> auth.users in the opposite order.

CREATE TABLE IF NOT EXISTS public.daily_challenge_progress_events (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  amounts jsonb NOT NULL CHECK (jsonb_typeof(amounts) = 'object'),
  magnitudes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(magnitudes) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_key)
);

CREATE TABLE IF NOT EXISTS public.daily_challenge_event_outbox (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  amounts jsonb NOT NULL,
  magnitudes jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_key)
);

CREATE TABLE IF NOT EXISTS public.daily_challenge_milestone_claims (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  streak_started_on date NOT NULL,
  milestone_days integer NOT NULL CHECK (milestone_days > 0),
  reward_chips numeric NOT NULL CHECK (reward_chips >= 0),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, streak_started_on, milestone_days)
);
