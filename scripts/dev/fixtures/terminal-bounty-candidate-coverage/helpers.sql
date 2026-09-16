-- Private qualification only: actual roots/readers/markers, documented wallet stand-in.
CREATE TABLE fixture_terminal_calls(kind text,tournament_id uuid);
ALTER FUNCTION public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)
 RENAME TO fixture_wallet_before_terminal_probe;
CREATE FUNCTION public.fn_settle_tournament_obligation(
 p_tournament_id uuid,p_kind text,p_place integer,p_user_id uuid,p_amount numeric,
 p_source text,p_description text DEFAULT NULL,p_adjustment_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE r jsonb; BEGIN
 INSERT INTO fixture_terminal_calls VALUES('payer',p_tournament_id);
 r:=fixture_wallet_before_terminal_probe(p_tournament_id,p_kind,p_place,p_user_id,
       p_amount,p_source,p_description,p_adjustment_id);
 -- The inherited stand-in emitted bounty_residual as its own category; the
 -- production residual payer uses bounty. Normalize only this local wallet.
 UPDATE wallet_transactions SET category='bounty'
  WHERE related_entity_id=p_tournament_id AND category='bounty_residual';
 RETURN r;
END $$;

CREATE FUNCTION fixture_terminal_case(p_mode text DEFAULT 'pko') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t uuid;h uuid;
 a uuid:='a0000000-0000-4000-8000-000000000001';
 b uuid:='b0000000-0000-4000-8000-000000000001';
BEGIN
 t:=fixture_event('R38 terminal candidate coverage',ARRAY[a,b]::text[],5);
 UPDATE tournaments SET is_pko=p_mode='pko',is_mystery_bounty=p_mode LIKE 'mystery%'
  WHERE id=t;
 h:=fixture_bust(t,a,b,7300001,clock_timestamp()-interval '5 seconds');
 UPDATE tournament_players SET status='winner',position=1 WHERE tournament_id=t AND user_id=b;
 RETURN jsonb_build_object('t',t,'a',a,'b',b,'hand',h);
END $$;

CREATE FUNCTION fixture_terminal_snapshot(t uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'players',(SELECT jsonb_agg(to_jsonb(x) ORDER BY user_id) FROM tournament_players x WHERE tournament_id=t),
 'markers',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounties x WHERE tournament_id=t),
 'wallet',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM wallet_transactions x WHERE related_entity_id=t),
 'obligations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounty_obligations x WHERE tournament_id=t),
 'event',(SELECT to_jsonb(x) FROM tournaments x WHERE id=t),
 'receipts',(SELECT to_jsonb(x) FROM tournament_bounty_completion_receipts x WHERE tournament_id=t),
 'awards',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounty_awards x WHERE tournament_id=t),
 'chests',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounty_chests x WHERE tournament_id=t),
 'payer_calls',(SELECT count(*) FROM fixture_terminal_calls WHERE tournament_id=t));
$$;
