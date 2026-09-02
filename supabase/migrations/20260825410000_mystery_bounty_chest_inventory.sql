-- ═══════════════════════════════════════════════════════════════════════════
--  MYSTERY BOUNTY — CHEST INVENTORY, AWARDS AND SPLIT KNOCKOUTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Replaces a mystery bounty model that was wrong in every dimension that
-- matters. Until this migration a player's mystery bounty was drawn by
-- Postgres `random()` inside fn_register_for_tournament, at the moment they
-- REGISTERED, and stored in plain sight on tournament_players.
--
--   * `random()` is a seeded PRNG. `setseed()` is available to any session and
--     the sequence is reproducible from the seed.
--   * The value sat in a readable row for the whole tournament, so which head
--     was worth chasing was knowable before the first hand was dealt.
--   * Independent per-player rolls are a draw WITH replacement, so the sum of
--     what the event paid bore no relationship to the pool that funded it. It
--     could pay more than it collected and nothing would have noticed.
--
-- The model here is an INVENTORY. Once entry closes and the configured
-- threshold is reached, one chest is created per surviving player, the whole
-- mystery pool is distributed across those chests in integer cents by the
-- engine (server/src/tournament/mysteryBountyPool.ts), and the order is
-- shuffled with the CSPRNG before it is stored. A knockout then takes the next
-- chest — `ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED` — which is race-free
-- and still a cryptographic draw, because the randomness was spent on the
-- shuffle.
--
-- MONEY IS INTEGER CENTS HERE, not numeric dollars. Section 12 requires the
-- event to reconcile to zero and the existing bounty path cannot: it is
-- floats with a round2 helper at every step. bigint cents cannot lose a cent,
-- and every table below has a CHECK that refuses a non-positive one.
--
-- WHY THE ENGINE BUILDS THE INVENTORY AND NOT THIS FILE. The tier ladder lives
-- in exactly one place, server/src/config/mysteryBountySpec.ts. A second copy
-- in PL/pgSQL is a second ladder, and the whole reason this migration exists
-- is that there were three of them and none agreed. fn_mystery_bounty_seed
-- therefore takes the chests as an argument and REFUSES to invent them; what
-- it does own is the pool arithmetic, the idempotency and the atomicity, none
-- of which the engine can be trusted with across a restart.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. TOURNAMENT CONFIGURATION
-- ───────────────────────────────────────────────────────────────────────────

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

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE INVENTORY
-- ───────────────────────────────────────────────────────────────────────────

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

-- The reserve path's whole query. Without this it is a sequential scan over
-- every chest in the event on every knockout, holding a row lock.
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
  -- SECTION 24: one bounty per eliminated player. This is the constraint that
  -- makes the elimination sweep safe to re-run: a second pass over the same
  -- bustout cannot draw a second chest, because the row it would need cannot
  -- exist. op_id above covers the narrower case of the same CALL retrying.
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

-- RLS: DENY BY DEFAULT, ON PURPOSE.
--
-- Section 19 says the pending broadcast must not carry the amount. That is
-- worth nothing if the client can read tournament_bounty_chests directly and
-- see what is coming — and worth less than nothing if it can read the whole
-- unshuffled inventory. So none of these three tables gets a SELECT policy for
-- authenticated at all. Every legitimate read goes through the SECURITY
-- DEFINER read functions below, which expose only what has already been
-- revealed. The engine uses the service role and bypasses RLS.
ALTER TABLE public.tournament_bounty_chests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_bounty_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_bounty_award_recipients ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tournament_bounty_chests FROM anon, authenticated;
REVOKE ALL ON public.tournament_bounty_awards FROM anon, authenticated;
REVOKE ALL ON public.tournament_bounty_award_recipients FROM anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. SEED — build the inventory once, idempotently
-- ───────────────────────────────────────────────────────────────────────────
--
-- p_chests is [{"tier":"jackpot","amount_cents":250000,"seq":1}, ...] already
-- shuffled by the engine. Passing NULL is refused rather than silently
-- generating a ladder here: see the header.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_seed(
  p_tournament_id uuid,
  p_players_remaining int,
  p_chests jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_pool_cents bigint;
  v_bounty_cents bigint;
  v_m numeric; v_r numeric;
  v_sum bigint; v_count int;
BEGIN
  SELECT id, is_mystery_bounty, prize_pool_finalized, bounty_pool,
         bounty_pool_paid, mystery_bounty_stage,
         mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
         mystery_bounty_pool_cents
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT COALESCE(v_t.is_mystery_bounty, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_mystery_bounty');
  END IF;

  -- IDEMPOTENT. The engine's activation check runs on a five-second sweep and
  -- a restart re-runs it; seeding twice would double the inventory and the
  -- event could never reconcile. Returning the existing state as `ok` (not as
  -- an error) is what lets the caller treat the sweep as harmless.
  IF v_t.mystery_bounty_stage <> 'pending' THEN
    SELECT count(*), COALESCE(sum(amount_cents), 0) INTO v_count, v_sum
      FROM public.tournament_bounty_chests WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_seeded', true,
      'stage', v_t.mystery_bounty_stage, 'chests', v_count,
      'pool_cents', COALESCE(v_t.mystery_bounty_pool_cents, v_sum));
  END IF;

  -- (a) ENTRY MUST BE CLOSED. bounty_pool still grows with every late entry,
  -- rebuy and add-on; an inventory built before the close is built from a pool
  -- smaller than the one the event ends up holding, and the difference could
  -- never be paid out.
  IF NOT COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_still_open');
  END IF;

  IF p_chests IS NULL OR jsonb_typeof(p_chests) <> 'array' OR jsonb_array_length(p_chests) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chests_required');
  END IF;
  IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_count_mismatch',
      'chests', jsonb_array_length(p_chests), 'players_remaining', p_players_remaining);
  END IF;

  -- The mystery half of the pool, in cents. bounty_pool is written with
  -- round(x,2) everywhere, so *100 is exact; the floor sends the odd cent to
  -- the REGULAR half, which is spent against a live exhaustion check, rather
  -- than to the mystery half, which is committed to a fixed inventory up front.
  v_bounty_cents := round(COALESCE(v_t.bounty_pool, 0) * 100)::bigint;
  v_m := GREATEST(0, COALESCE(v_t.mystery_bounty_pool_percent, 50));
  v_r := GREATEST(0, COALESCE(v_t.mystery_bounty_regular_pool_percent, 50));
  IF v_m + v_r <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_split_misconfigured');
  END IF;
  v_pool_cents := floor(v_bounty_cents * v_m / (v_m + v_r))::bigint;

  -- Anything already paid out as an ordinary pre-activation knockout came from
  -- the regular half; if it ate into the mystery half the event is already
  -- short and seeding a full inventory would promise money that is gone.
  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint THEN
    v_pool_cents := GREATEST(0, v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint);
  END IF;

  IF v_pool_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_pool');
  END IF;

  SELECT COALESCE(sum((c->>'amount_cents')::bigint), 0) INTO v_sum
    FROM jsonb_array_elements(p_chests) c;

  -- THE RECONCILIATION STARTS HERE. If the inventory does not sum to the pool
  -- at the moment it is created it can never sum to it later, and the mismatch
  -- would not surface until completion, hours after anything could be done.
  IF v_sum <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_mismatch',
      'inventory_cents', v_sum, 'pool_cents', v_pool_cents);
  END IF;

  INSERT INTO public.tournament_bounty_chests (tournament_id, seq, tier, amount_cents)
  SELECT p_tournament_id,
         COALESCE((c->>'seq')::int, ord::int),
         c->>'tier',
         (c->>'amount_cents')::bigint
    FROM jsonb_array_elements(p_chests) WITH ORDINALITY AS t(c, ord)
  ON CONFLICT (tournament_id, seq) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_chests) THEN
    RAISE EXCEPTION 'mystery bounty seed inserted % of % chests', v_count, jsonb_array_length(p_chests);
  END IF;

  UPDATE public.tournaments
     SET mystery_bounty_stage = 'active',
         mystery_bounty_activated_at = now(),
         mystery_bounty_activated_players = p_players_remaining,
         mystery_bounty_pool_cents = v_pool_cents
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'already_seeded', false,
    'pool_cents', v_pool_cents, 'chests', v_count, 'stage', 'active');
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. RESERVE — take the next chest, atomically, and split it
-- ───────────────────────────────────────────────────────────────────────────
--
-- p_recipients is [{"user_id":"...","weight":1200,"is_designated_revealer":true}].
-- Weights are chip contributions against the busted stack (sections 27/28); the
-- split is largest-remainder so it is exact to the cent.
--
-- THIS FUNCTION DOES NOT RETURN THE AMOUNT. Section 19: the pending broadcast
-- must not carry it, and the surest way to keep it out of a broadcast is for
-- the call that builds the broadcast never to have seen it.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reserve(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_recipients jsonb,
  p_table_id uuid,
  p_hand_id text,
  p_op_id uuid,
  p_reveal_ms int DEFAULT 20000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stage text;
  v_existing record;
  v_chest record;
  v_award_id uuid;
  v_revealer uuid;
  v_idx int; v_total int;
  v_n int;
BEGIN
  IF p_eliminated_user_id IS NULL OR p_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_party');
  END IF;

  -- IDEMPOTENCY, TWO WAYS. op_id catches the same call retrying (a network
  -- blip on the engine side); (tournament_id, eliminated_user_id) catches the
  -- elimination sweep processing the same bustout twice, which it does after
  -- any restart. Both return the SAME award rather than an error, so the
  -- caller's happy path and its retry path are one path.
  SELECT id, status, table_id INTO v_existing
    FROM public.tournament_bounty_awards
   WHERE op_id = p_op_id
      OR (tournament_id = p_tournament_id AND eliminated_user_id = p_eliminated_user_id)
   LIMIT 1;

  IF FOUND THEN
    SELECT count(*) INTO v_total FROM public.tournament_bounty_awards a
     WHERE a.tournament_id = p_tournament_id
       AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
       AND a.status IN ('reserved','revealed');
    SELECT count(*) INTO v_idx FROM public.tournament_bounty_awards a
     WHERE a.tournament_id = p_tournament_id
       AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
       AND a.status IN ('reserved','revealed')
       AND a.reserved_at <= (SELECT reserved_at FROM public.tournament_bounty_awards WHERE id = v_existing.id);
    SELECT user_id INTO v_revealer FROM public.tournament_bounty_award_recipients
     WHERE award_id = v_existing.id AND is_designated_revealer LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', v_existing.id,
      'status', v_existing.status, 'queue_index', GREATEST(v_idx, 1), 'queue_total', GREATEST(v_total, 1),
      'designated_revealer', v_revealer,
      'recipient_user_ids', COALESCE((SELECT jsonb_agg(user_id) FROM public.tournament_bounty_award_recipients WHERE award_id = v_existing.id), '[]'::jsonb));
  END IF;

  SELECT mystery_bounty_stage INTO v_stage FROM public.tournaments WHERE id = p_tournament_id;
  IF v_stage IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'mystery_phase_not_active', 'stage', v_stage);
  END IF;

  IF p_recipients IS NULL OR jsonb_typeof(p_recipients) <> 'array'
     OR jsonb_array_length(p_recipients) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_recipients');
  END IF;

  -- THE DRAW. SKIP LOCKED means two knockouts landing in the same instant take
  -- two DIFFERENT chests instead of queueing on one row; ORDER BY seq means
  -- they take them in the order the CSPRNG shuffle fixed at seed time.
  UPDATE public.tournament_bounty_chests
     SET status = 'reserved'
   WHERE id = (
     SELECT id FROM public.tournament_bounty_chests
      WHERE tournament_id = p_tournament_id AND status = 'available'
      ORDER BY seq
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING id, tier, amount_cents INTO v_chest;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_exhausted');
  END IF;

  INSERT INTO public.tournament_bounty_awards
    (tournament_id, chest_id, table_id, hand_id, eliminated_user_id,
     amount_cents, tier, status, op_id, reveal_deadline_at)
  VALUES (p_tournament_id, v_chest.id, p_table_id, p_hand_id, p_eliminated_user_id,
          v_chest.amount_cents, v_chest.tier, 'reserved', p_op_id,
          now() + make_interval(secs => GREATEST(1, COALESCE(p_reveal_ms, 20000)) / 1000.0))
  RETURNING id INTO v_award_id;

  UPDATE public.tournament_bounty_chests SET award_id = v_award_id WHERE id = v_chest.id;

  -- THE SPLIT. Largest remainder over the weights, with the leftover cents
  -- going to the largest fractional parts first. A knockout shared three ways
  -- out of a chest worth an odd number of cents still pays out exactly the
  -- chest — which is the only reason this is not `amount / n` rounded.
  --
  -- Done as one CTE rather than temp tables: a function that creates a temp
  -- table is a function that behaves differently the second time it runs in a
  -- transaction, and this one runs once per knockout.
  WITH raw AS (
    SELECT (r->>'user_id')::uuid AS user_id,
           GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
           COALESCE((r->>'is_designated_revealer')::boolean, false) AS flagged
      FROM jsonb_array_elements(p_recipients) r
     WHERE (r->>'user_id') IS NOT NULL
  ),
  -- One player holding two claims on one knockout (a stranded seat row, a
  -- re-sweep) must not be paid twice out of one chest.
  dedup AS (
    SELECT user_id, sum(weight) AS weight, bool_or(flagged) AS flagged
      FROM raw GROUP BY user_id
  ),
  -- All weights zero (the engine could not reconstruct the side pots) means an
  -- equal share each: refusing would strand the chest, and equal shares are
  -- the only defensible guess.
  norm AS (
    SELECT user_id,
           CASE WHEN (SELECT sum(weight) FROM dedup) > 0 THEN weight ELSE 1 END AS weight,
           flagged
      FROM dedup
  ),
  alloc AS (
    SELECT n.user_id, n.weight,
           floor(v_chest.amount_cents * n.weight / t.w)::bigint AS fl,
           (v_chest.amount_cents * n.weight / t.w)
             - floor(v_chest.amount_cents * n.weight / t.w) AS frac
      FROM norm n CROSS JOIN (SELECT sum(weight) AS w FROM norm) t
  ),
  ranked AS (
    SELECT a.*,
           row_number() OVER (ORDER BY a.frac DESC, a.weight DESC, a.user_id) AS rn,
           (SELECT v_chest.amount_cents - COALESCE(sum(fl), 0) FROM alloc) AS leftover
      FROM alloc a
  )
  INSERT INTO public.tournament_bounty_award_recipients
    (award_id, user_id, amount_cents, is_designated_revealer)
  SELECT v_award_id, user_id, fl + CASE WHEN rn <= leftover THEN 1 ELSE 0 END, false
    FROM ranked
  ON CONFLICT (award_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_recipients');
  END IF;

  -- The designated revealer is whoever the engine flagged, and failing that
  -- the largest claim. Someone has to be the player who taps the chest, and
  -- it should be whoever had the most at stake.
  SELECT user_id INTO v_revealer FROM (
    SELECT (r->>'user_id')::uuid AS user_id,
           GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
           COALESCE((r->>'is_designated_revealer')::boolean, false) AS flagged
      FROM jsonb_array_elements(p_recipients) r
     WHERE (r->>'user_id') IS NOT NULL
  ) q ORDER BY q.flagged DESC, q.weight DESC, q.user_id LIMIT 1;

  UPDATE public.tournament_bounty_award_recipients
     SET is_designated_revealer = (user_id = v_revealer)
   WHERE award_id = v_award_id;

  -- The chest must be exactly accounted for before this transaction commits.
  PERFORM 1 FROM public.tournament_bounty_award_recipients
    WHERE award_id = v_award_id HAVING sum(amount_cents) = v_chest.amount_cents;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mystery bounty split lost money on award %', v_award_id;
  END IF;

  SELECT count(*) INTO v_total FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.table_id IS NOT DISTINCT FROM p_table_id
     AND a.status IN ('reserved','revealed');
  v_idx := v_total;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', v_award_id,
    'queue_index', GREATEST(v_idx, 1), 'queue_total', GREATEST(v_total, 1),
    'designated_revealer', v_revealer,
    'reveal_deadline_ms', GREATEST(1, COALESCE(p_reveal_ms, 20000)),
    'recipient_user_ids', COALESCE((SELECT jsonb_agg(user_id) FROM public.tournament_bounty_award_recipients WHERE award_id = v_award_id), '[]'::jsonb));
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. REVEAL — the tap
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reveal(
  p_award_id uuid,
  p_actor_user_id uuid,
  p_auto boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record;
  v_revealer uuid;
  v_payload jsonb;
BEGIN
  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;

  SELECT user_id INTO v_revealer FROM public.tournament_bounty_award_recipients
   WHERE award_id = p_award_id AND is_designated_revealer LIMIT 1;

  -- AUTHORISATION. Anyone can call an RPC, so this is the line that stops a
  -- spectator opening someone else's chest. p_auto is the engine's own
  -- deadline path, which the service role reaches and a browser does not.
  IF NOT COALESCE(p_auto, false) AND (p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_revealer) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_the_revealer');
  END IF;

  IF v_a.status = 'reserved' THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'revealed', revealed_at = now() WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests SET status = 'revealed' WHERE id = v_a.chest_id;
  END IF;
  -- Already revealed / paid / completed falls through and returns the same
  -- payload. A double tap, a reconnect replaying the tap, and the deadline
  -- firing a millisecond after a real tap all land here, and all three must
  -- show the player the same number.

  v_payload := jsonb_build_object(
    'ok', true,
    'award_id', v_a.id,
    'tournament_id', v_a.tournament_id,
    'table_id', v_a.table_id,
    'hand_id', v_a.hand_id,
    'amount_cents', v_a.amount_cents,
    'tier', v_a.tier,
    'is_jackpot', v_a.tier = 'jackpot',
    'eliminated_user_id', v_a.eliminated_user_id,
    'designated_revealer', v_revealer,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents)
                       ORDER BY amount_cents DESC, user_id)
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb)
  );
  RETURN v_payload;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. PAY — money leaves the pool here and nowhere else
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record; v_r record; v_paid bigint := 0; v_credited boolean;
BEGIN
  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;

  IF v_a.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', p_award_id,
                              'amount_cents', v_a.amount_cents);
  END IF;
  IF v_a.status = 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_revealed');
  END IF;

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id AND paid_at IS NULL AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    -- fn_credit_and_log is the ONLY way money reaches a wallet. The key makes
    -- the credit itself idempotent, so calling this function twice cannot pay
    -- twice even if the paid_at stamp below never lands.
    v_credited := public.fn_credit_and_log(
      v_r.user_id,
      (v_r.amount_cents / 100.0)::numeric,
      'mb:' || p_award_id::text || ':' || v_r.user_id::text,
      'bounty',
      'Mystery bounty revealed from eliminated player',
      v_a.tournament_id
    );

    UPDATE public.tournament_bounty_award_recipients SET paid_at = now() WHERE id = v_r.id;

    IF COALESCE(v_credited, false) THEN
      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id AND user_id = v_r.user_id;

      -- Keep the LEGACY bounty ledger in step. tournament_bounties is what
      -- every existing leaderboard, stat and audit query reads; leaving it
      -- empty for mystery events would make the new model invisible to all of
      -- them. Its unique key is (tournament, eliminated, collector), which a
      -- split knockout satisfies with one row per collector.
      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount, is_mystery_revealed)
      VALUES (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
              (v_r.amount_cents / 100.0)::numeric, true)
      ON CONFLICT (tournament_id, eliminated_player_id, collector_player_id) DO NOTHING;
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    -- The funded pool's drawdown counter. fn_finalize_bounty_pool settles
    -- bounty_pool - bounty_pool_paid to the champion at completion, so a
    -- mystery payment that did not move this number would be paid twice: once
    -- to the knocker and again to the winner as "unclaimed".
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  UPDATE public.tournament_bounty_awards
     SET status = 'completed', paid_at = now() WHERE id = p_award_id;
  UPDATE public.tournament_bounty_chests SET status = 'paid' WHERE id = v_a.chest_id;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. SETTLE — sections 46 and 71, the books must balance
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(
  p_tournament_id uuid,
  p_winner_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool bigint; v_paid bigint; v_unclaimed bigint; v_stage text;
BEGIN
  SELECT mystery_bounty_stage, COALESCE(mystery_bounty_pool_cents, 0)
    INTO v_stage, v_pool
    FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF v_stage = 'pending' THEN
    -- Never activated: the mystery half was never carved out, so the ordinary
    -- bounty settlement covers the whole pool and there is nothing here.
    RETURN jsonb_build_object('ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0);
  END IF;

  SELECT COALESCE(sum(r.amount_cents), 0) INTO v_paid
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id AND r.paid_at IS NOT NULL;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_unclaimed
    FROM public.tournament_bounty_chests
   WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');

  -- UNCLAIMED CHESTS GO TO THE CHAMPION. The last player standing was never
  -- knocked out, so their own chest — and any chest a broken elimination left
  -- behind — is theirs. Paid through the same idempotent credit path as every
  -- other bounty; the key is the tournament, not the chest, so a re-run cannot
  -- pay it twice.
  IF v_unclaimed > 0 AND p_winner_user_id IS NOT NULL THEN
    PERFORM public.fn_credit_and_log(
      p_winner_user_id, (v_unclaimed / 100.0)::numeric,
      'mb-residual:' || p_tournament_id::text,
      'bounty', 'Unclaimed mystery bounty chests awarded to champion',
      p_tournament_id);
    UPDATE public.tournament_players
       SET bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_unclaimed / 100.0), 2)
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_unclaimed / 100.0), 2)
     WHERE id = p_tournament_id;
    UPDATE public.tournament_bounty_chests SET status = 'void'
     WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');
    v_paid := v_paid + v_unclaimed;
  END IF;

  UPDATE public.tournaments SET mystery_bounty_stage = 'complete' WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'pool_cents', v_pool, 'settled_cents', v_paid, 'unclaimed_cents', v_unclaimed,
    'balanced', v_paid = v_pool,
    'variance_cents', v_paid - v_pool);
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. READ PATHS (for the lobby and the results page)
-- ───────────────────────────────────────────────────────────────────────────
--
-- These are the ONLY way a client sees any of this. They deliberately expose
-- the tier LADDER (how many chests of each size exist, and how many are left)
-- while never revealing which chest is next: that is the information the
-- lobby needs and the information a player must not have.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_inventory(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'pool_cents', COALESCE(t.mystery_bounty_pool_cents, 0),
    'stage', t.mystery_bounty_stage,
    'profile', t.mystery_bounty_profile,
    'activation', t.mystery_bounty_activation,
    'activation_value', t.mystery_bounty_activation_value,
    'activated_players', t.mystery_bounty_activated_players,
    'activated_at', t.mystery_bounty_activated_at,
    'tiers', COALESCE((
      SELECT jsonb_agg(row_to_json(x) ORDER BY x.amount_cents DESC)
        FROM (
          SELECT c.tier,
                 c.amount_cents,
                 count(*)::int AS original,
                 count(*) FILTER (WHERE c.status IN ('reserved','revealed','paid'))::int AS awarded,
                 count(*) FILTER (WHERE c.status = 'available')::int AS remaining
            FROM public.tournament_bounty_chests c
           WHERE c.tournament_id = p_tournament_id
           GROUP BY c.tier, c.amount_cents
        ) x
    ), '[]'::jsonb))
  FROM public.tournaments t WHERE t.id = p_tournament_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_awards(
  p_tournament_id uuid,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.tournament_bounty_awards
               WHERE tournament_id = p_tournament_id AND status IN ('revealed','paid','completed')),
    'rows', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.revealed_at DESC NULLS LAST)
        FROM (
          SELECT a.id AS award_id, a.amount_cents, a.tier,
                 a.tier = 'jackpot' AS is_jackpot,
                 a.revealed_at, a.hand_id, a.table_id,
                 jsonb_build_object('user_id', a.eliminated_user_id,
                   'username', COALESCE(tp.username, 'Player')) AS eliminated,
                 COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                            'user_id', rc.user_id,
                            'username', COALESCE(tp2.username, 'Player'),
                            'amount_cents', rc.amount_cents)
                          ORDER BY rc.amount_cents DESC)
                     FROM public.tournament_bounty_award_recipients rc
                     LEFT JOIN public.tournament_players tp2
                       ON tp2.tournament_id = a.tournament_id AND tp2.user_id = rc.user_id
                    WHERE rc.award_id = a.id), '[]'::jsonb) AS recipients
            FROM public.tournament_bounty_awards a
            LEFT JOIN public.tournament_players tp
              ON tp.tournament_id = a.tournament_id AND tp.user_id = a.eliminated_user_id
           WHERE a.tournament_id = p_tournament_id
             AND a.status IN ('revealed','paid','completed')
           ORDER BY a.revealed_at DESC NULLS LAST
           LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
          OFFSET GREATEST(0, COALESCE(p_offset, 0))
        ) r
    ), '[]'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_leaderboard(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('rows', COALESCE((
    SELECT jsonb_agg(row_to_json(x) ORDER BY x.earnings_cents DESC, x.username)
      FROM (
        SELECT rc.user_id,
               COALESCE(tp.username, 'Player') AS username,
               count(*)::int AS bounties_won,
               sum(rc.amount_cents)::bigint AS earnings_cents
          FROM public.tournament_bounty_award_recipients rc
          JOIN public.tournament_bounty_awards a ON a.id = rc.award_id
          LEFT JOIN public.tournament_players tp
            ON tp.tournament_id = a.tournament_id AND tp.user_id = rc.user_id
         WHERE a.tournament_id = p_tournament_id
           AND a.status IN ('revealed','paid','completed')
         GROUP BY rc.user_id, tp.username
      ) x
  ), '[]'::jsonb));
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. NEUTRALISE THE REGISTRATION-TIME DRAW
-- ───────────────────────────────────────────────────────────────────────────
--
-- fn_collect_bounty pays out `tournament_players.current_bounty`, which for a
-- mystery event was the registration-time `random()` roll. Two changes:
--
--   (a) it refuses outright once the mystery phase is active, because the
--       chest path owns the money from then on and two paths paying one
--       knockout is how a pool goes negative;
--   (b) `mystery_bounty_value` is no longer consulted. The register functions
--       below stop writing it, but 9,000 historical rows still carry a value
--       and a re-swept old tournament must not pay from it.
--
-- Before activation a mystery event pays an ORDINARY bounty out of the regular
-- half of the pool. That is deliberate: knockouts happen during late
-- registration and those players are owed something, and it is the same flat
-- bounty every other bounty format pays.

CREATE OR REPLACE FUNCTION public.fn_collect_bounty(p_tournament_id uuid, p_eliminated_user_id uuid, p_collector_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_elim record;
  v_head numeric; v_available numeric; v_payable numeric;
  v_cash numeric; v_to_head numeric;
  v_cents integer; v_cash_cents integer;
  v_mode text; v_funded boolean;
BEGIN
  IF p_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_party');
  END IF;

  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         bounty_pool, bounty_pool_paid, mystery_bounty_stage
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_bounty_tournament');
  END IF;

  -- (a) THE CHEST PATH OWNS THIS KNOCKOUT.
  IF COALESCE(v_t.is_mystery_bounty, false) AND v_t.mystery_bounty_stage = 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
  END IF;

  IF EXISTS (SELECT 1 FROM tournament_bounties
              WHERE tournament_id = p_tournament_id
                AND eliminated_player_id = p_eliminated_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_collected');
  END IF;

  SELECT current_bounty INTO v_elim
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
   FOR UPDATE;

  v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                 WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
                 ELSE 'regular' END;

  -- (b) mystery_bounty_value is deliberately NOT in this COALESCE any more.
  v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
  IF v_head <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_head_value');
  END IF;

  v_funded  := COALESCE(v_t.bounty_pool, 0) > 0;
  v_available := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);

  IF v_funded THEN
    IF v_available <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                'head', v_head, 'available', v_available);
    END IF;
    v_payable := LEAST(v_head, v_available);
  ELSE
    v_payable := v_head;
  END IF;

  IF v_mode = 'pko' THEN
    v_cents      := round(v_payable * 100)::integer;
    v_cash_cents := (v_cents / 2)::integer;
    v_cash       := v_cash_cents / 100.0;
    v_to_head    := (v_cents - v_cash_cents) / 100.0;
  ELSE
    v_cash := v_payable; v_to_head := 0;
  END IF;

  IF v_cash > 0 THEN
    PERFORM public.credit_player_wallet(
      p_collector_user_id, v_cash,
      'tourney:' || p_tournament_id || ':bounty:' || p_eliminated_user_id
        || ':' || p_collector_user_id);
    PERFORM public.log_wallet_transaction(
      p_collector_user_id, 'PLAYER', v_cash, 'credit', 'bounty',
      CASE v_mode WHEN 'pko'         THEN 'PKO bounty (cash half) from eliminated player'
                  WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
                  ELSE 'Bounty collected from eliminated player' END,
      NULL, NULL, p_tournament_id);
  END IF;

  UPDATE tournament_players
     SET bounties_collected = COALESCE(bounties_collected,0) + 1,
         bounty_winnings    = round(COALESCE(bounty_winnings,0) + v_cash, 2),
         current_bounty     = round(COALESCE(current_bounty,0) + v_to_head, 2)
   WHERE tournament_id = p_tournament_id AND user_id = p_collector_user_id;

  UPDATE tournament_players SET current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

  IF v_funded THEN
    UPDATE tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_cash, 2)
     WHERE id = p_tournament_id;
  END IF;

  INSERT INTO tournament_bounties
    (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
     added_to_collector_bounty, is_mystery_revealed)
  VALUES (p_tournament_id, p_eliminated_user_id, p_collector_user_id, v_payable,
          CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END,
          false);

  RETURN jsonb_build_object('ok', true, 'mode', v_mode, 'funded', v_funded,
    'head', v_head, 'paid_cash', v_cash, 'added_to_head', v_to_head,
    'capped', v_funded AND v_payable < v_head,
    'pool_remaining', CASE WHEN v_funded THEN round(v_available - v_cash, 2) END);
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. GRANTS
-- ───────────────────────────────────────────────────────────────────────────
--
-- seed / reserve / pay / settle move money or decide who gets what. They are
-- ENGINE-ONLY: the service role reaches them and nothing else does. reveal is
-- the one a browser calls, because a player taps their own chest, and it
-- checks the caller against the designated revealer before it does anything.

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_seed(uuid, int, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve(uuid, uuid, jsonb, uuid, text, uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_seed(uuid, int, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reserve(uuid, uuid, jsonb, uuid, text, uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_inventory(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_awards(uuid, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_leaderboard(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_inventory(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_awards(uuid, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_leaderboard(uuid) TO authenticated, service_role;
