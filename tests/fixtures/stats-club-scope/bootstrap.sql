CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;

CREATE FUNCTION public.ca_assert_self(p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public
AS $$ BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user THEN
    RAISE EXCEPTION 'self only' USING ERRCODE='42501';
  END IF;
END $$;

CREATE TABLE public.clubs(
  id uuid PRIMARY KEY, name text NOT NULL, lifecycle_status text, asset text
);
CREATE TABLE public.club_members(
  club_id uuid NOT NULL, user_id uuid NOT NULL, status text NOT NULL
);
CREATE TABLE public.ca_hand_facts(
  hand_id uuid NOT NULL, user_id uuid NOT NULL, club_id uuid, table_id uuid,
  tournament_id uuid, played_at timestamptz NOT NULL, game_variant text NOT NULL,
  big_blind numeric NOT NULL, seat smallint, position text NOT NULL,
  players_dealt smallint NOT NULL, hole_cards jsonb, hand_class text,
  invested numeric NOT NULL, returned numeric NOT NULL, net numeric NOT NULL,
  net_bb numeric NOT NULL, rake_paid numeric NOT NULL DEFAULT 0,
  vpip boolean NOT NULL DEFAULT false, pfr boolean NOT NULL DEFAULT false,
  three_bet boolean NOT NULL DEFAULT false, faced_three_bet boolean NOT NULL DEFAULT false,
  folded_to_three_bet boolean NOT NULL DEFAULT false,
  had_cbet_flop_opp boolean NOT NULL DEFAULT false,
  cbet_flop boolean NOT NULL DEFAULT false, saw_flop boolean NOT NULL DEFAULT false,
  went_to_showdown boolean NOT NULL DEFAULT false,
  won_at_showdown boolean NOT NULL DEFAULT false,
  aggressive_actions smallint NOT NULL DEFAULT 0,
  passive_actions smallint NOT NULL DEFAULT 0,
  was_all_in boolean NOT NULL DEFAULT false, ev_net_bb numeric NOT NULL DEFAULT 0,
  opponent_ids uuid[] NOT NULL DEFAULT '{}', PRIMARY KEY(hand_id,user_id)
);
CREATE TABLE public.hand_history(
  id uuid PRIMARY KEY, club_id uuid, pot_size numeric, board jsonb, community_cards text[]
);
CREATE TABLE public.ca_hand_player_stat(
  user_id uuid NOT NULL,hand_id uuid NOT NULL,created_at timestamptz NOT NULL,is_cash boolean NOT NULL,
  tournament_id uuid,game_variant text NOT NULL,big_blind numeric NOT NULL,small_blind numeric NOT NULL DEFAULT 0,
  n_players int,seat_position text NOT NULL,my_blind numeric NOT NULL,won_amt numeric NOT NULL,
  is_winner boolean NOT NULL,invested_actions numeric NOT NULL,aggro_cnt int NOT NULL DEFAULT 0,
  call_cnt int NOT NULL DEFAULT 0,vpip boolean NOT NULL,pfr boolean NOT NULL,folded boolean NOT NULL DEFAULT false,
  three_bet boolean NOT NULL DEFAULT false,three_bet_opp boolean NOT NULL DEFAULT false,
  faced_three_bet boolean NOT NULL DEFAULT false,folded_to_three_bet boolean NOT NULL DEFAULT false,
  cbet_opp boolean NOT NULL DEFAULT false,cbet_made boolean NOT NULL DEFAULT false,showdown boolean NOT NULL DEFAULT false,
  hand_secs numeric NOT NULL DEFAULT 0,profit numeric NOT NULL,asset text NOT NULL DEFAULT 'chips',PRIMARY KEY(user_id,hand_id)
);
CREATE TABLE public.ca_hand_notes(
  user_id uuid NOT NULL, hand_id uuid NOT NULL, note text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}', PRIMARY KEY(user_id,hand_id)
);
CREATE TABLE public.tournaments(
  id uuid PRIMARY KEY, club_id uuid NOT NULL, name text, start_time timestamptz,
  ended_at timestamptz, status text,
  variant text, buy_in_amount numeric, buy_in_fee numeric, rebuy_cost numeric,
  addon_cost numeric, is_mystery_bounty boolean
);
CREATE TABLE public.tournament_players(
  id uuid PRIMARY KEY, tournament_id uuid NOT NULL, user_id uuid NOT NULL,
  registered_at timestamptz, status text, position integer, prize numeric,
  bounty_winnings numeric, bounties_collected integer, rebuys integer, add_on boolean
);
CREATE TABLE public.ca_hand_transfers(
  winner_id uuid, loser_id uuid, club_id uuid, played_at timestamptz, amount numeric
);
CREATE TABLE public.profiles(id uuid PRIMARY KEY, username text, avatar_url text);

-- Installed production dependency used only as the bounded analysis base by
-- the All-Clubs facade. The assertions prove the authoritative overlay does
-- not inherit these deliberately wrong headline values.
CREATE FUNCTION public.ca_player_stats_full(uuid,integer,text,text) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{"overall":{"total_hands":750,"total_profit":-999},"positions":[],"sessions":[],"quality":{},"coverage":{}}'::jsonb $$;
