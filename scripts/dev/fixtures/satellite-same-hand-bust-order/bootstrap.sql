-- Minimal schema for the satellite same-hand bust-order probe.
--
-- Only the objects public.fn_ca_assert_satellite_cohort_standings and the
-- shared bust witness public.fn_ca_tournament_bust_at actually read. Every
-- function body under test is the byte-exact production capture in
-- installed.sql; nothing here is a stand-in for one.
\set ON_ERROR_STOP on

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'RUNNING',
  tournament_type text NOT NULL DEFAULT 'SATELLITE',
  format_contract text NOT NULL DEFAULT 'mtt-v2',
  satellite_target_id uuid,
  satellite_seats integer
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  status text NOT NULL,
  position integer,
  chips numeric NOT NULL DEFAULT 0,
  eliminated_at timestamptz,
  elimination_sequence bigint,
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE public.tournament_satellite_settlements (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  receipt_version integer NOT NULL DEFAULT 3,
  winner_id uuid,
  field_size integer NOT NULL,
  ticket_award_count integer NOT NULL,
  qualifier_ids uuid[] NOT NULL
);

CREATE TABLE public.tournament_knockout_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  eliminated_user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  stack_before numeric NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tournament_knockout_candidates_user_hand
  ON public.tournament_knockout_candidates
     (tournament_id, eliminated_user_id, hand_number DESC, id DESC);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (table_id, hand_number)
);

CREATE SCHEMA probe;

-- One satellite whose cohort is already settled except for the ladder under
-- test: `p_positions` lists the eliminated users worst-place-first.
CREATE OR REPLACE FUNCTION probe.satellite(
  p_tournament_id uuid, p_qualifiers uuid[], p_eliminated uuid[]
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u uuid; i integer := 0;
BEGIN
  INSERT INTO public.tournaments (id) VALUES (p_tournament_id);
  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, field_size, ticket_award_count, qualifier_ids)
  VALUES (p_tournament_id,
          cardinality(p_qualifiers) + cardinality(p_eliminated),
          cardinality(p_qualifiers) + 1,
          (SELECT array_agg(DISTINCT q ORDER BY q) FROM unnest(p_qualifiers) q));
  FOREACH u IN ARRAY p_qualifiers LOOP
    INSERT INTO public.tournament_players (tournament_id, user_id, status, chips)
    VALUES (p_tournament_id, u, 'winner', 1000);
  END LOOP;
  FOREACH u IN ARRAY p_eliminated LOOP
    i := i + 1;
    INSERT INTO public.tournament_players
      (tournament_id, user_id, status, chips, eliminated_at, elimination_sequence)
    VALUES (p_tournament_id, u, 'eliminated', 0, now(), i);
  END LOOP;
END $$;

-- A bust the door recorded: the hand that took the stack, the stack the player
-- started that hand with, and the hand's commit.
CREATE OR REPLACE FUNCTION probe.bust(
  p_tournament_id uuid, p_table_id uuid, p_user_id uuid,
  p_hand_number bigint, p_stack_before numeric, p_committed_at timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_hand uuid := ('00000000-0000-4000-8000-' || lpad(p_hand_number::text, 12, '0'))::uuid;
BEGIN
  INSERT INTO public.hand_atomic_commits (table_id, hand_number, hand_id, committed_at)
  VALUES (p_table_id, p_hand_number, v_hand, p_committed_at)
  ON CONFLICT (table_id, hand_number) DO NOTHING;
  INSERT INTO public.tournament_knockout_candidates
    (tournament_id, eliminated_user_id, table_id, hand_id, hand_number, stack_before, state, created_at)
  VALUES (p_tournament_id, p_user_id, p_table_id, v_hand, p_hand_number,
          p_stack_before, 'eliminated', p_committed_at);
END $$;

-- Number the eliminated ladder in the given order, BEST place first.
CREATE OR REPLACE FUNCTION probe.place(p_tournament_id uuid, p_order uuid[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_live integer; u uuid; i integer := 0;
BEGIN
  SELECT count(*) INTO v_live FROM public.tournament_players
   WHERE tournament_id = p_tournament_id AND status <> 'eliminated';
  FOREACH u IN ARRAY p_order LOOP
    i := i + 1;
    UPDATE public.tournament_players SET position = v_live + i
     WHERE tournament_id = p_tournament_id AND user_id = u;
  END LOOP;
END $$;

-- Does the installed standings gate accept this cohort?
CREATE OR REPLACE FUNCTION probe.accepts(p_tournament_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.fn_ca_assert_satellite_cohort_standings(p_tournament_id);
  RETURN true;
EXCEPTION WHEN SQLSTATE 'P0404' THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION probe.check(p_ok boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'PROBE FAILED: %', p_what USING ERRCODE = 'P0001';
  END IF;
  RAISE NOTICE 'ok: %', p_what;
END $$;
