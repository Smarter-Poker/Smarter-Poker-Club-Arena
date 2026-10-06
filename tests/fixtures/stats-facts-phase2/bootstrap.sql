CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;

CREATE TABLE public.clubs(
  id uuid PRIMARY KEY,asset text NOT NULL DEFAULT 'chips',lifecycle_status text DEFAULT 'active'
);
CREATE TABLE public.club_members(
  club_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,
  PRIMARY KEY(club_id,user_id)
);
CREATE TABLE public.tables(id uuid PRIMARY KEY,club_id uuid NOT NULL REFERENCES public.clubs(id));
CREATE TABLE public.hand_history(
  id uuid PRIMARY KEY,table_id uuid NOT NULL,tournament_id uuid,hand_number bigint,
  created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,
  pot_size numeric,community_cards text[],community_cards2 text[],community_cards3 text[],
  rit_boards jsonb,players jsonb NOT NULL DEFAULT '[]',actions jsonb NOT NULL DEFAULT '[]',
  winners jsonb,winners_by_board jsonb,game_variant text NOT NULL DEFAULT 'nlh',
  small_blind numeric NOT NULL DEFAULT 0,big_blind numeric NOT NULL DEFAULT 0,
  rake_amount numeric NOT NULL DEFAULT 0,bbj_amount numeric NOT NULL DEFAULT 0,
  button_seat smallint,hole_cards jsonb,showdown jsonb,pots jsonb,bomb_pot jsonb,kill_pot jsonb
);
CREATE TABLE public.hand_atomic_commits(
  table_id uuid NOT NULL,hand_number bigint NOT NULL,hand_id uuid NOT NULL UNIQUE,
  post_commit_payload jsonb,PRIMARY KEY(table_id,hand_number)
);
CREATE TABLE public.ca_hand_facts(
  hand_id uuid NOT NULL,user_id uuid NOT NULL,club_id uuid,table_id uuid,tournament_id uuid,
  played_at timestamptz NOT NULL,game_variant text NOT NULL,big_blind numeric NOT NULL,
  seat smallint,position text NOT NULL,players_dealt smallint NOT NULL,opponent_ids uuid[],
  hole_cards jsonb,hand_class text,invested numeric NOT NULL,returned numeric NOT NULL,
  net numeric NOT NULL,net_bb numeric NOT NULL,rake_paid numeric NOT NULL DEFAULT 0,
  vpip boolean NOT NULL DEFAULT false,pfr boolean NOT NULL DEFAULT false,
  three_bet boolean NOT NULL DEFAULT false,four_bet boolean NOT NULL DEFAULT false,
  faced_three_bet boolean NOT NULL DEFAULT false,folded_to_three_bet boolean NOT NULL DEFAULT false,
  had_cbet_flop_opp boolean NOT NULL DEFAULT false,cbet_flop boolean NOT NULL DEFAULT false,
  saw_flop boolean NOT NULL DEFAULT false,went_to_showdown boolean NOT NULL DEFAULT false,
  won_at_showdown boolean NOT NULL DEFAULT false,aggressive_actions smallint NOT NULL DEFAULT 0,
  passive_actions smallint NOT NULL DEFAULT 0,was_all_in boolean NOT NULL DEFAULT false,
  all_in_street text,all_in_at_risk numeric,all_in_equity numeric,ev_returned numeric,
  ev_net numeric NOT NULL,ev_net_bb numeric NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  all_in_equity_owed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(hand_id,user_id)
);
CREATE TABLE public.ca_hand_transfers(
  hand_id uuid NOT NULL,winner_id uuid NOT NULL,loser_id uuid NOT NULL,amount numeric NOT NULL,
  played_at timestamptz NOT NULL,club_id uuid,table_id uuid,
  PRIMARY KEY(hand_id,winner_id,loser_id)
);
CREATE TABLE public.ca_hand_player_stat(
  hand_id uuid NOT NULL,user_id uuid NOT NULL,won_amt numeric,profit numeric,is_winner boolean,
  PRIMARY KEY(hand_id,user_id)
);
CREATE TABLE public.ca_hand_player_idx(
  hand_id uuid NOT NULL,user_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,hand_id)
);

CREATE FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(p_hand_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='public','pg_temp' AS $function$
DECLARE v_h record;
BEGIN
  SELECT p_hand_id AS id INTO v_h;
  -- Projection 4: exact per-hand stats materialisation and player index.
  RETURN jsonb_build_object('ok',true);
END
$function$;
