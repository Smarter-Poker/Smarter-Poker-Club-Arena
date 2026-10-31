DO $$ BEGIN CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA realtime;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.viewer',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;
CREATE TABLE realtime.messages(extension text,private boolean,topic text); ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('realtime.topic',true) $$;
CREATE TABLE public.signals(topic text,payload jsonb);
CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.signals VALUES(topic,payload) $$;
CREATE TABLE club_members(user_id uuid,club_id uuid,role text,agent_id uuid,chip_balance numeric,promo_balance numeric,nickname text,notes text,display_name text,joined_at timestamptz,status text);
CREATE TABLE clubs(id uuid,name text);
CREATE TABLE profiles(id uuid,player_number text,alias text,username text,display_name text,first_name text,last_name text,full_name text,arena_avatar_url text,avatar_url text,last_login timestamptz,last_seen timestamptz,is_online boolean,status text);
CREATE TABLE tables(id uuid,status text,club_id uuid);
CREATE TABLE table_seats(user_id uuid,table_id uuid,club_id uuid,left_at timestamptz,joined_at timestamptz);
CREATE TABLE agents(user_id uuid,club_id uuid,status text,agent_wallet_balance numeric,promo_wallet_balance numeric);
CREATE TABLE chip_transactions(to_user_id uuid,from_user_id uuid,club_id uuid,amount numeric,transaction_type text,created_at timestamptz);
CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text);
CREATE TABLE club_member_daily_facts(club_id uuid,user_id uuid,played_on date,game_variant text,is_mtt boolean,hands bigint,wins bigint,vpip_hands bigint,pfr_hands bigint,tb_hands bigint,faced_tb bigint,folded_tb bigint,cb_hands bigint,cb_opps bigint,fees numeric,net numeric);
CREATE TABLE club_member_play_totals(club_id uuid,user_id uuid,hands bigint,mtt_hands bigint,fees numeric,mtt_fees numeric,net numeric,mtt_net numeric);
CREATE TABLE club_member_daily_facts_state(singleton boolean,initialized boolean); INSERT INTO club_member_daily_facts_state VALUES(true,true);
CREATE TABLE ca_hand_facts(hand_id uuid,user_id uuid,club_id uuid,table_id uuid,tournament_id uuid,played_at timestamptz,game_variant text,net numeric,rake_paid numeric,vpip boolean,pfr boolean,three_bet boolean,faced_three_bet boolean,folded_to_three_bet boolean,cbet_flop boolean,had_cbet_flop_opp boolean);
CREATE INDEX ON ca_hand_facts(user_id,played_at);
CREATE TABLE rake_attributions(hand_id uuid,player_id uuid,club_id uuid,PRIMARY KEY(hand_id,player_id));
CREATE TABLE cash_participant_funding_receipts(id uuid,operation_kind text,table_id uuid,account_entity_id uuid,funding_club_id uuid,seat_joined_at timestamptz,recorded_at timestamptz);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,club_id uuid);
CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz) RETURNS boolean LANGUAGE sql AS $$ SELECT nullif(current_setting('test.cutoff',true),'') IS NULL OR $2>=nullif(current_setting('test.cutoff',true),'')::timestamptz $$;
CREATE FUNCTION fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[$1] $$;
CREATE FUNCTION ca_club_roster_access(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.access',true),''),'staff') $$;
CREATE FUNCTION fn_club_role_rank(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
CREATE FUNCTION ca_club_member_fee_totals(uuid,date,date,uuid) RETURNS TABLE(user_id uuid,cash_fees numeric,tournament_fees numeric) LANGUAGE sql AS $$ SELECT $4,16.55::numeric,0::numeric $$;
CREATE FUNCTION ca_club_member_tournament_money(uuid,uuid,timestamptz,timestamptz) RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$;

CREATE TABLE ca_club_rake_daily_user(user_id uuid,club_id uuid);
CREATE TABLE ca_club_member_tournament_fee_daily(user_id uuid,club_id uuid);

CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid) RETURNS timestamptz LANGUAGE sql AS $$ SELECT nullif(current_setting('test.cutoff',true),'')::timestamptz $$;


CREATE SCHEMA extensions;
CREATE ROLE postgres SUPERUSER;
ALTER TABLE club_members ADD last_active_at timestamptz; ALTER TABLE club_members ADD updated_at timestamptz;
ALTER TABLE table_seats ADD stack numeric;
ALTER TABLE chip_transactions ADD notes text; ALTER TABLE chip_transactions ADD balance_after numeric; ALTER TABLE chip_transactions ADD table_id uuid;
CREATE TABLE chip_ledger(club_id uuid,from_entity_id uuid,to_entity_id uuid,from_type text,to_type text,amount numeric,tournament_id uuid,status text,created_at timestamptz);
CREATE TABLE tournaments(id uuid,game_type text);
CREATE TABLE accounting_tournament_fee_sources(club_id uuid,player_id uuid,tournament_id uuid,charged_at timestamptz,rake_credit numeric);
CREATE FUNCTION fn_ca_fee_counting_start() RETURNS date LANGUAGE sql AS $$ SELECT '2026-01-01'::date $$;
DROP FUNCTION ca_club_member_fee_totals(uuid,date,date,uuid);
CREATE FUNCTION ca_club_member_fee_totals(uuid,date,date,uuid) RETURNS TABLE(user_id uuid,cash_fees numeric,tournament_fees numeric,total_fees numeric) LANGUAGE sql AS $$ SELECT $4,0::numeric,0::numeric,0::numeric $$;
CREATE TABLE bbj_pools(id uuid PRIMARY KEY,main_balance numeric,backup_balance numeric,total_paid_out numeric,updated_at timestamptz);
CREATE TABLE bbj_payouts(id uuid PRIMARY KEY,pool_id uuid,table_id uuid,hand_id uuid,hand_number bigint,kind text);
CREATE TABLE bbj_payout_recipients(payout_id uuid,user_id uuid,amount numeric,created_at timestamptz DEFAULT now(),PRIMARY KEY(payout_id,user_id));
CREATE TABLE bbj_unclaimed_shares(payout_id uuid,pool_id uuid,table_id uuid,user_id uuid,amount numeric,reason text,paid_at timestamptz,paid_note text,PRIMARY KEY(payout_id,user_id));
CREATE TABLE wallet_credit_idempotency(key text PRIMARY KEY,user_id uuid,amount numeric);
CREATE TABLE union_pnl_cash_outcomes(table_id uuid,hand_number bigint,evidence jsonb,PRIMARY KEY(table_id,hand_number));
CREATE TABLE hand_history(id uuid PRIMARY KEY,game_variant text,started_at timestamptz DEFAULT now());
CREATE FUNCTION fn_ensure_club_wallet(uuid,uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION fn_ca_declare_ledger(text,text,uuid,uuid,text,uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION fn_player_home_club(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION fn_publish_member_record_user(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO signals VALUES('member-record:'||$1::text,jsonb_build_object('user_id',$1));
 PERFORM pg_notify('jackpot_fixture_committed',$1::text);
END $$;
CREATE FUNCTION public.fn_member_record_fact_club(f public.ca_hand_facts) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(
   (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
    WHERE f.tournament_id IS NULL AND x.operation_kind='buyin' AND x.table_id=f.table_id
      AND x.account_entity_id=f.user_id AND x.seat_joined_at<=f.played_at
    ORDER BY x.seat_joined_at DESC,x.recorded_at DESC,x.id DESC LIMIT 1),
   (SELECT tp.club_id FROM public.tournament_players tp WHERE tp.tournament_id=f.tournament_id AND tp.user_id=f.user_id),
   (SELECT ra.club_id FROM public.rake_attributions ra WHERE ra.hand_id=f.hand_id AND ra.player_id=f.user_id),
   f.club_id);
$$;

CREATE VIEW member_record_daily_facts AS SELECT fn_member_record_fact_club(f) club_id,user_id,
 (played_at AT TIME ZONE 'UTC')::date played_on,lower(game_variant) game_variant,tournament_id IS NOT NULL is_mtt,
 count(*) hands,count(*) FILTER(WHERE net>0) wins,0::bigint vpip_hands,0::bigint pfr_hands,0::bigint tb_hands,
 0::bigint faced_tb,0::bigint folded_tb,0::bigint cb_hands,0::bigint cb_opps,0::numeric fees,sum(net) net,
 fn_ca_launch_accounting_cutoff('club',fn_member_record_fact_club(f)) accounting_cutoff
 FROM ca_hand_facts f WHERE fn_ca_launch_accounting_accepts(fn_member_record_fact_club(f),played_at)
 GROUP BY 1,2,3,4,5,17;
CREATE FUNCTION ca_member_record_daily_facts(uuid,uuid,date,date) RETURNS SETOF club_member_daily_facts LANGUAGE sql AS $$
 SELECT club_id,user_id,played_on,game_variant,is_mtt,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net
 FROM member_record_daily_facts WHERE club_id=$1 AND user_id=$2 AND ($3 IS NULL OR played_on>=$3) AND ($4 IS NULL OR played_on<=$4) $$;
CREATE FUNCTION ca_club_member_chicago_today_cash(uuid,uuid) RETURNS numeric LANGUAGE sql AS $$
 SELECT coalesce(sum(net),0) FROM ca_hand_facts f WHERE user_id=$2 AND fn_member_record_fact_club(f)=$1 AND tournament_id IS NULL
 AND played_at>=((now() AT TIME ZONE 'America/Chicago')::date::timestamp AT TIME ZONE 'America/Chicago')
 AND played_at<(((now() AT TIME ZONE 'America/Chicago')::date+1)::timestamp AT TIME ZONE 'America/Chicago')
 AND fn_ca_launch_accounting_accepts($1,played_at) $$;
CREATE FUNCTION public.ca_club_member_chicago_cash(
  p_club_id uuid, p_user_id uuid, p_from date, p_to date
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT p_from::timestamp AT TIME ZONE 'UTC' AS utc_start,
      p_from::timestamp AT TIME ZONE 'America/Chicago' AS chicago_start,
      p_to::timestamp AT TIME ZONE 'America/Chicago' AS chicago_end,
      (p_to + 1)::timestamp AT TIME ZONE 'UTC' AS utc_end
  )
  -- UTC buckets p_from .. p_to cover the Chicago range. Remove only their edges.
  SELECT CASE WHEN p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN 0::numeric ELSE
         (SELECT coalesce(sum(d.net), 0)
            FROM public.ca_member_record_daily_facts(p_club_id,p_user_id,p_from,p_to) d
           WHERE NOT d.is_mtt)
       - (SELECT coalesce(sum(edge.net), 0) FROM (
            SELECT f.net FROM public.ca_hand_facts f
             WHERE f.user_id=p_user_id AND f.tournament_id IS NULL
               AND f.played_at >= b.utc_start AND f.played_at < b.chicago_start
               AND public.fn_member_record_fact_club(f)=p_club_id
               AND public.fn_ca_launch_accounting_accepts(p_club_id,f.played_at)
            UNION ALL
            SELECT f.net FROM public.ca_hand_facts f
             WHERE f.user_id=p_user_id AND f.tournament_id IS NULL
               AND f.played_at >= b.chicago_end AND f.played_at < b.utc_end
               AND public.fn_member_record_fact_club(f)=p_club_id
               AND public.fn_ca_launch_accounting_accepts(p_club_id,f.played_at)
          ) edge) END
    FROM bounds b;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_member_chicago_cash(uuid,uuid,date,date)
  FROM PUBLIC, anon, authenticated, service_role;

