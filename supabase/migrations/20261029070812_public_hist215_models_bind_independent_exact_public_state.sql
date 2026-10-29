-- TIER 3: additive numeric public_hist215_v1; legacy matrix contracts preserved.
-- Source qualification is separate from dataset certification and activation.
-- Independent public physics arithmetic. No source labels or caller predictions.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='240s';
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_rank(p_cards integer[])
RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE counts integer[]:=array_fill(0,ARRAY[15]); sc integer[]:=array_fill(0,ARRAY[4]); sm integer[]:=array_fill(0,ARRAY[4]); mask integer:=0; c integer; r integer; s integer; hi integer; st integer:=0; fs integer:=0; q integer:=0; tr integer[]:=ARRAY[]::integer[]; pa integer[]:=ARRAY[]::integer[]; ranks integer[]:=ARRAY[]::integer[]; vals integer[]; cat integer:=0; result integer;
BEGIN
 -- Called only with the internally validated public deck by the private WTL owner.
 IF cardinality(p_cards) NOT BETWEEN 5 AND 7 THEN RAISE EXCEPTION 'public215 rank requires5..7 cards'; END IF;
 FOREACH c IN ARRAY p_cards LOOP
  r:=c/4+2;s:=c%4+1;counts[r]:=counts[r]+1;sc[s]:=sc[s]+1;mask:=mask|(1<<r);sm[s]:=sm[s]|(1<<r);
 END LOOP;
 FOR s IN 1..4 LOOP
  IF sc[s]>=5 THEN
   FOR hi IN REVERSE 14..6 LOOP IF (sm[s]&(31<<(hi-4)))=(31<<(hi-4)) THEN st:=hi;EXIT;END IF;END LOOP;
   IF st=0 AND (sm[s]&16444)=16444 THEN st:=5;END IF;
   IF st>0 THEN cat:=8;vals:=ARRAY[st];EXIT;END IF;fs:=s;
  END IF;
 END LOOP;
 IF cat<>8 THEN
  FOR r IN REVERSE 14..2 LOOP
   IF counts[r]>0 THEN ranks:=array_append(ranks,r);END IF;
   IF counts[r]>=2 THEN pa:=array_append(pa,r);END IF;
   IF counts[r]>=3 THEN tr:=array_append(tr,r);END IF;
   IF counts[r]=4 THEN q:=r;END IF;
  END LOOP;
  IF q>0 THEN cat:=7;FOREACH r IN ARRAY ranks LOOP IF r<>q THEN vals:=ARRAY[q,r];EXIT;END IF;END LOOP;
  ELSIF cardinality(tr)>0 AND EXISTS(SELECT 1 FROM unnest(pa) x WHERE x<>tr[1]) THEN
   cat:=6;FOREACH r IN ARRAY pa LOOP IF r<>tr[1] THEN vals:=ARRAY[tr[1],r];EXIT;END IF;END LOOP;
  ELSIF fs>0 THEN cat:=5;vals:=ARRAY[]::integer[];FOR r IN REVERSE 14..2 LOOP IF (sm[fs]&(1<<r))<>0 THEN vals:=array_append(vals,r);END IF;END LOOP;
  ELSE
   st:=0;FOR hi IN REVERSE 14..6 LOOP IF (mask&(31<<(hi-4)))=(31<<(hi-4)) THEN st:=hi;EXIT;END IF;END LOOP;
   IF st=0 AND (mask&16444)=16444 THEN st:=5;END IF;
   IF st>0 THEN cat:=4;vals:=ARRAY[st];
   ELSIF cardinality(tr)>0 THEN cat:=3;vals:=ARRAY[tr[1]];FOREACH r IN ARRAY ranks LOOP IF r<>tr[1] AND cardinality(vals)<3 THEN vals:=array_append(vals,r);END IF;END LOOP;
   ELSIF cardinality(pa)>=2 THEN cat:=2;FOREACH r IN ARRAY ranks LOOP IF r<>pa[1] AND r<>pa[2] THEN vals:=ARRAY[pa[1],pa[2],r];EXIT;END IF;END LOOP;
   ELSIF cardinality(pa)=1 THEN cat:=1;vals:=ARRAY[pa[1]];FOREACH r IN ARRAY ranks LOOP IF r<>pa[1] AND cardinality(vals)<4 THEN vals:=array_append(vals,r);END IF;END LOOP;
   ELSE vals:=ranks;END IF;
  END IF;
 END IF;
 result:=cat;FOR r IN 1..5 LOOP result:=result*15+COALESCE(vals[r],0);END LOOP;RETURN result;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_wtl(p_own integer[],p_board integer[],p_weights numeric[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE blocked boolean[]:=array_fill(false,ARRAY[52]); seen integer[]:=ARRAY[]::integer[]; oa integer[]:=ARRAY[]::integer[];ob integer[]:=ARRAY[]::integer[];ow numeric[]:=ARRAY[]::numeric[]; n integer; i integer:=1;a integer;b integer;c integer;k integer;x integer;y integer; runs integer:=0;factor integer;z0 numeric:=0;tw numeric:=0;tt numeric:=0;tz numeric:=0;cw numeric:=0;ct numeric:=0;total numeric:=0;w numeric;hs integer;vs integer;fb integer[];new1 integer;new2 integer;
BEGIN
 n:=cardinality(p_board);
 IF cardinality(p_own)<>2 OR n NOT IN(3,4,5) OR cardinality(p_weights)<>1326 OR array_lower(p_own,1)<>1 OR array_lower(p_board,1)<>1 OR array_lower(p_weights,1)<>1 THEN RAISE EXCEPTION 'public215 shape';END IF;
 FOREACH c IN ARRAY p_own||p_board LOOP
  IF c IS NULL OR c<0 OR c>51 OR blocked[c+1] THEN RAISE EXCEPTION 'public215 invalid deck';END IF;blocked[c+1]:=true;
 END LOOP;
 FOREACH w IN ARRAY p_weights LOOP
  IF w IS NULL OR w<0 OR w<>trunc(w) OR w>9223372036854775807 THEN RAISE EXCEPTION 'public215 invalid integer root weight';END IF;total:=total+w;
 END LOOP;
 IF total<=0 OR total>9223372036854775807 THEN RAISE EXCEPTION 'public215 root sum bounds';END IF;
 FOR b IN 1..51 LOOP FOR a IN 0..b-1 LOOP
  w:=p_weights[i];i:=i+1;
  IF w>0 AND NOT blocked[a+1] AND NOT blocked[b+1] THEN oa:=array_append(oa,a);ob:=array_append(ob,b);ow:=array_append(ow,w);z0:=z0+w;END IF;
 END LOOP;END LOOP;
 IF z0=0 THEN RAISE EXCEPTION 'public215 zero own-compatible mass';END IF;
 hs:=public.fn_gto_v31_public215_rank(p_board||p_own);
 FOR i IN 1..cardinality(oa) LOOP vs:=public.fn_gto_v31_public215_rank(p_board||ARRAY[oa[i],ob[i]]);IF hs>vs THEN cw:=cw+ow[i];ELSIF hs=vs THEN ct:=ct+ow[i];END IF;END LOOP;
 -- Public own-compatible runouts:1081/46/1; opponent-conditional denominator990/44/1.
 FOR x IN -1..51 LOOP
  IF (n=5 AND x<>-1) OR (n<5 AND (x=-1 OR blocked[x+1])) THEN CONTINUE;END IF;
  FOR y IN -1..51 LOOP
   IF (n>=4 AND y<>-1) OR (n=3 AND (y<=x OR blocked[y+1])) THEN CONTINUE;END IF;
   fb:=p_board;IF x>=0 THEN fb:=array_append(fb,x);END IF;IF y>=0 THEN fb:=array_append(fb,y);END IF;runs:=runs+1;hs:=public.fn_gto_v31_public215_rank(fb||p_own);
   FOR i IN 1..cardinality(oa) LOOP
    IF oa[i]=x OR oa[i]=y OR ob[i]=x OR ob[i]=y THEN CONTINUE;END IF;
    vs:=public.fn_gto_v31_public215_rank(fb||ARRAY[oa[i],ob[i]]);tz:=tz+ow[i];IF hs>vs THEN tw:=tw+ow[i];ELSIF hs=vs THEN tt:=tt+ow[i];END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 factor:=CASE n WHEN 3 THEN 990 WHEN 4 THEN 44 ELSE 1 END;
 IF runs<>(CASE n WHEN 3 THEN 1081 WHEN 4 THEN 46 ELSE 1 END) OR tz<>z0*factor THEN RAISE EXCEPTION 'public215 exact joint denominator';END IF;
 RETURN jsonb_build_object('current',jsonb_build_array(cw::text,ct::text,(z0-cw-ct)::text,z0::text),'terminal',jsonb_build_array(tw::text,tt::text,(tz-tw-tt)::text,tz::text),'terminalRunouts',runs,'opponentCompatibleCombos',cardinality(oa));
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_f64(p_hex text)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE b bytea;e integer;m bigint;v double precision;i integer;
BEGIN
 IF p_hex!~'^[0-9a-f]{16}$' THEN RAISE EXCEPTION 'public215 f64 word';END IF;
 b:=decode(p_hex,'hex');e:=((get_byte(b,0)&127)<<4)|(get_byte(b,1)>>4);
 IF e=2047 THEN RAISE EXCEPTION 'public215 nonfinite f64';END IF;
 m:=get_byte(b,1)&15;FOR i IN 2..7 LOOP m:=m*256+get_byte(b,i);END LOOP;
 IF e=0 THEN v:=(m::double precision/4503599627370496::double precision)*power(2::double precision,-1022::double precision);
 ELSE v:=(1::double precision+m::double precision/4503599627370496::double precision)*power(2::double precision,(e-1023)::double precision);END IF;
 IF get_byte(b,0)>=128 THEN v:=-v;END IF;
 IF encode(float8send(v),'hex')<>p_hex THEN RAISE EXCEPTION 'public215 f64 decode identity';END IF;
 RETURN v;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_canonical(p jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE t text;v record;parts text[]:=ARRAY[]::text[];
BEGIN
 CASE jsonb_typeof(p)
 WHEN 'object' THEN
  FOR v IN SELECT key,value FROM jsonb_each(p) ORDER BY key COLLATE "C" LOOP
   IF v.key!~'^[ -~]*$' THEN RAISE EXCEPTION 'public215 canonical ASCII key';END IF;
   parts:=array_append(parts,to_jsonb(v.key)::text||':'||public.fn_gto_v31_public215_canonical(v.value));
  END LOOP;RETURN '{'||array_to_string(parts,',')||'}';
 WHEN 'array' THEN
  FOR v IN SELECT value FROM jsonb_array_elements(p) LOOP parts:=array_append(parts,public.fn_gto_v31_public215_canonical(v.value));END LOOP;RETURN '['||array_to_string(parts,',')||']';
 WHEN 'string' THEN IF (p#>>'{}')!~'^[ -~]*$' THEN RAISE EXCEPTION 'public215 canonical ASCII';END IF;RETURN p::text;
 WHEN 'number' THEN t:=p::text;IF t!~'^-?(0|[1-9][0-9]*)$' OR abs(t::numeric)>9007199254740991 OR t='-0' THEN RAISE EXCEPTION 'public215 canonical safeinteger';END IF;RETURN t;
 ELSE RETURN p::text;
 END CASE;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_model_valid(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE acts jsonb;head jsonb;trees jsonb;tree jsonb;node jsonb;ni integer;n integer;leaves integer;visited boolean[];stack integer[];child integer;which text;f double precision;
BEGIN
 IF jsonb_typeof(p)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>8 OR NOT p?&ARRAY['format','variant','feature_count','action_ids','heads','template_sha256','feature_schema_sha256','provenance_sha256'] OR jsonb_typeof(p->'format')<>'string' OR jsonb_typeof(p->'variant')<>'string' OR p->>'format'<>'public_hist215_v1' OR p->>'variant' NOT IN('direct','coherent') OR p->'feature_count'<>'215'::jsonb THEN RETURN false;END IF;
 PERFORM public.fn_gto_v31_public215_canonical(p);
 IF octet_length(public.fn_gto_v31_public215_canonical(p))>8388608 THEN RETURN false;END IF;
 FOREACH which IN ARRAY ARRAY['template_sha256','feature_schema_sha256','provenance_sha256'] LOOP IF jsonb_typeof(p->which)<>'string' OR p->>which!~'^[0-9a-f]{64}$' THEN RETURN false;END IF;END LOOP;
 acts:=p->'action_ids';IF jsonb_typeof(acts)<>'array' OR jsonb_array_length(acts) NOT BETWEEN 1 AND 16 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(acts))<>jsonb_array_length(acts) OR EXISTS(SELECT 1 FROM jsonb_array_elements(acts)a WHERE jsonb_typeof(a)<>'string' OR a#>>'{}'!~'^[A-Za-z0-9_.:-]{1,96}$' OR a#>>'{}' IN('__proto__','prototype','constructor')) THEN RETURN false;END IF;
 IF jsonb_typeof(p->'heads')<>'array' OR jsonb_array_length(p->'heads')<>1+2*jsonb_array_length(acts) THEN RETURN false;END IF;
 FOR head IN SELECT value FROM jsonb_array_elements(p->'heads') LOOP
  IF jsonb_typeof(head)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(head))<>2 OR NOT head?&ARRAY['baseline_f64','trees'] THEN RETURN false;END IF;
  IF jsonb_typeof(head->'baseline_f64')<>'string' THEN RETURN false;END IF;f:=public.fn_gto_v31_public215_f64(head->>'baseline_f64');trees:=head->'trees';IF jsonb_typeof(trees)<>'array' OR jsonb_array_length(trees)<>100 THEN RETURN false;END IF;
  FOR tree IN SELECT value FROM jsonb_array_elements(trees) LOOP
   IF jsonb_typeof(tree)<>'array' OR jsonb_array_length(tree) NOT BETWEEN 1 AND 29 THEN RETURN false;END IF;
   n:=jsonb_array_length(tree);leaves:=0;
   FOR ni IN 0..n-1 LOOP
    node:=tree->ni;IF jsonb_typeof(node)<>'object' THEN RETURN false;END IF;
    IF node?'value_f64' THEN
     IF (SELECT count(*) FROM jsonb_object_keys(node))<>1 OR jsonb_typeof(node->'value_f64')<>'string' THEN RETURN false;END IF;f:=public.fn_gto_v31_public215_f64(node->>'value_f64');leaves:=leaves+1;
    ELSE
     IF (SELECT count(*) FROM jsonb_object_keys(node))<>5 OR NOT node?&ARRAY['feature','threshold_f64','left','right','missing_left'] OR jsonb_typeof(node->'missing_left')<>'boolean' THEN RETURN false;END IF;
     FOREACH which IN ARRAY ARRAY['feature','left','right'] LOOP IF jsonb_typeof(node->which)<>'number' OR node->>which!~'^(0|[1-9][0-9]*)$' THEN RETURN false;END IF;END LOOP;
     IF (node->>'feature')::numeric>214 OR (node->>'left')::numeric>=n OR (node->>'right')::numeric>=n OR node->'left'=node->'right' THEN RETURN false;END IF;IF jsonb_typeof(node->'threshold_f64')<>'string' THEN RETURN false;END IF;f:=public.fn_gto_v31_public215_f64(node->>'threshold_f64');
    END IF;
   END LOOP;
   IF leaves>15 OR n<>2*leaves-1 THEN RETURN false;END IF;
   visited:=array_fill(false,ARRAY[n]);stack:=ARRAY[0];
   WHILE cardinality(stack)>0 LOOP
    ni:=stack[cardinality(stack)];stack:=stack[1:cardinality(stack)-1];IF visited[ni+1] THEN RETURN false;END IF;visited[ni+1]:=true;node:=tree->ni;
    IF NOT node?'value_f64' THEN stack:=stack||ARRAY[(node->>'left')::integer,(node->>'right')::integer];END IF;
   END LOOP;
   IF array_position(visited,false) IS NOT NULL THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_f64(text),public.fn_gto_v31_public215_canonical(jsonb),public.fn_gto_v31_public215_model_valid(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_ratio(p_n numeric,p_d numeric)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE e integer:=0;n numeric:=p_n;q numeric;r numeric;
BEGIN
 IF p_n<0 OR p_d<=0 OR p_n>p_d OR p_n<>trunc(p_n) OR p_d<>trunc(p_d) OR p_d>9223372036854775807::numeric*990 THEN RAISE EXCEPTION 'public215 ratio bounds';END IF;
 IF p_n=0 THEN RETURN 0::double precision;END IF;
 WHILE n<p_d LOOP n:=n*2;e:=e-1;END LOOP;
 n:=p_n*power(2::numeric,52-e);q:=div(n,p_d);r:=n-q*p_d;
 IF r*2>p_d OR (r*2=p_d AND mod(q,2)=1) THEN q:=q+1;END IF;
 RETURN q::double precision*power(2::double precision,(e-52)::double precision);
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_graph(p_own integer[],p_board integer[])
RETURNS double precision[] LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE h integer[];f integer[];slots integer[];v integer[];best integer[];i integer;j integer;a integer;b integer;c integer;hi integer;
BEGIN
 IF cardinality(p_own)<>2 OR cardinality(p_board) NOT IN(3,4,5) OR EXISTS(SELECT 1 FROM unnest(p_own||p_board)x WHERE x IS NULL OR x NOT BETWEEN 0 AND 51) OR (SELECT count(DISTINCT x) FROM unnest(p_own||p_board)x)<>cardinality(p_board)+2 THEN RAISE EXCEPTION 'public215 graph shape';END IF;
 FOR hi IN 0..1 LOOP
  h:=CASE WHEN hi=0 THEN p_own ELSE ARRAY[p_own[2],p_own[1]] END;
  IF h[1]/4<h[2]/4 THEN CONTINUE;END IF;
  FOR a IN 1..3 LOOP FOR b IN 1..3 LOOP FOR c IN 1..3 LOOP
   IF a=b OR a=c OR b=c THEN CONTINUE;END IF;f:=ARRAY[p_board[a],p_board[b],p_board[c]];
   IF f[1]/4<f[2]/4 OR f[2]/4<f[3]/4 THEN CONTINUE;END IF;
   slots:=h||f||ARRAY[COALESCE(p_board[4],-1),COALESCE(p_board[5],-1)];v:=ARRAY[]::integer[];
   FOR i IN 1..7 LOOP v:=array_append(v,CASE WHEN slots[i]<0 THEN 0 ELSE slots[i]/4+2 END);END LOOP;
   FOR i IN 1..7 LOOP FOR j IN i+1..7 LOOP v:=array_append(v,CASE WHEN slots[i]>=0 AND slots[j]>=0 AND slots[i]%4=slots[j]%4 THEN 1 ELSE 0 END);END LOOP;END LOOP;
   IF best IS NULL OR v<best THEN best:=v;END IF;
  END LOOP;END LOOP;END LOOP;
 END LOOP;
 RETURN best::double precision[];
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_base181(p_combo integer,p_board text,p_template jsonb)
RETURNS double precision[] LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE prior text[]:=ARRAY['allcount10','allcount11','allcount12','allcount13','allcount14','allcount2','allcount3','allcount4','allcount5','allcount6','allcount7','allcount8','allcount9','boardcount10','boardcount11','boardcount12','boardcount13','boardcount14','boardcount2','boardcount3','boardcount4','boardcount5','boardcount6','boardcount7','boardcount8','boardcount9','boardmaxsuit','boardrank0','boardrank1','boardrank2','boardrank3','boardrank4','depth','facing_kind=all_in','facing_kind=bet','facing_kind=none','facing_kind=raise','facing_size_bucket=all_in','facing_size_bucket=none','facing_size_bucket=small','flushrank','game_family=cash','game_family=spin','game_family=tourney_ev','game_family=tourney_icm','hero_position=BB','hero_position=BTN','hero_position=SB','hgap','hhigh','hlow','holesuitboard0','holesuitboard1','hpocket','hsuited','iprange=01b3d4e721b36cf6d8d89fd4941b5ece0e9fd2853f61d1e5f98fbebb3f8f5228','iprange=46a1052fd09045ea14940360740c08c8e45786680fb629b992bd6dd60dbb7448','iprange=4e711cfed033f777818cc507b6c54c1963959d325916fad5eeb2903076817dea','iprange=53b631c6ee33a42f19c276dceef8e49bff0f5d012f3332200301e8e02a6f2e7f','iprange=5cfa49e8e307dde353df59384f9af0078989b1f79b610cd6ffce687952817eeb','iprange=7297e35f5f97d678bf1c50f2c67f00b676d0da819459b34b566abeb553dfee21','matches','maxsuit','node_role=all_in','node_role=barrel','node_role=bet_raise','node_role=cbet','node_role=check_raise','node_role=delayed_cbet','node_role=facing_bet','node_role=facing_raise','node_role=open','node_role=probe','nover','npairs','nquads','ntrips','nunder','objective=cash_ev','objective=chip_ev','objective=icm','ooprange=3ac1e6fa6d92a000680addaf06eab130d2af9467d2e90aceae7cb542b8725c11','ooprange=4002e2111513d1de3ea6dec8a16bedb436fdd7f9a34ea6f08e2f5e95ee7bba1a','ooprange=505f32cd9ae2cef66951fcaecc0e8a8fc217ef1d4c0010bc0fe7b57ccf5a417a','ooprange=5cfa49e8e307dde353df59384f9af0078989b1f79b610cd6ffce687952817eeb','ooprange=6f7f9456008af722359ef4b8d53353c7e3fbdb94412a2d7cc206526cf2857a1b','ooprange=85a3cb6615c4547abb4e559d5858dfbdc40eb4938abbf14c1bbf564c027b6c7e','opponent_position=BB','opponent_position=BTN','opponent_position=SB','pot_type=3bet','pot_type=4bet_plus','pot_type=limped','pot_type=srp','potbb','rakecap','rakepct','span','stackbb','straighttop','straightwindow','street=flop','street=river','street=turn','tablesize','utility_context=bubble','utility_context=cash_ev','utility_context=chip_ev','utility_context=final_table','utility_context=in_money','utility_context=ladder','utility_context=satellite','utility_context=spin_ladder'];own integer[];cards integer[];board integer[]:=ARRAY[]::integer[];ranks integer[];br integer[];hr integer[];bc integer[]:=array_fill(0,ARRAY[15]);ac integer[]:=array_fill(0,ARRAY[15]);sc integer[]:=array_fill(0,ARRAY[4]);bs integer[]:=array_fill(0,ARRAY[4]);ctx jsonb:=p_template->'context';scenario jsonb:=p_template->'scenario';f jsonb:='{}';v jsonb;out double precision[]:=ARRAY[]::double precision[];i integer;j integer;r integer;n integer;high integer;low integer;card integer;tmp integer;k text;val jsonb;matches integer:=0;nover integer:=0;nunder integer:=0;np integer:=0;nt integer:=0;nq integer:=0;maxs integer:=0;maxbs integer:=0;flushrank integer:=0;sw integer:=0;st integer:=0;hits integer;top integer;wr integer;countv integer;
BEGIN
 IF p_combo NOT BETWEEN 0 AND 1325 OR p_board!~'^([2-9TJQKA][cdhs]){3,5}$' THEN RAISE EXCEPTION 'public215 cards';END IF;
 high:=floor((1+sqrt(1+8*p_combo))/2)::integer;WHILE high*(high-1)/2>p_combo LOOP high:=high-1;END LOOP;WHILE (high+1)*high/2<=p_combo LOOP high:=high+1;END LOOP;low:=p_combo-high*(high-1)/2;own:=ARRAY[low,high];
 n:=length(p_board)/2;FOR i IN 0..n-1 LOOP board:=array_append(board,(strpos('23456789TJQKA',substr(p_board,2*i+1,1))-1)*4+strpos('cdhs',substr(p_board,2*i+2,1))-1);END LOOP;
 cards:=own||board;IF (SELECT count(DISTINCT x) FROM unnest(cards)x)<>n+2 THEN RAISE EXCEPTION 'public215 impossible deck';END IF;
 FOREACH card IN ARRAY board LOOP bc[card/4+2]:=bc[card/4+2]+1;bs[card%4+1]:=bs[card%4+1]+1;END LOOP;
 -- Original f09 hole normalization: rank descending, then matching-board suitcount descending.
 IF own[1]/4<own[2]/4 OR (own[1]/4=own[2]/4 AND bs[own[1]%4+1]<bs[own[2]%4+1]) THEN tmp:=own[1];own[1]:=own[2];own[2]:=tmp;END IF;
 FOREACH card IN ARRAY cards LOOP ac[card/4+2]:=ac[card/4+2]+1;sc[card%4+1]:=sc[card%4+1]+1;END LOOP;
 hr:=ARRAY[own[1]/4+2,own[2]/4+2];SELECT array_agg(x.value/4+2 ORDER BY x.value/4 DESC) INTO br FROM unnest(board)x(value);
 FOR i IN 1..2 LOOP matches:=matches+bc[hr[i]];IF hr[i]>br[1] THEN nover:=nover+1;END IF;IF hr[i]<br[n] THEN nunder:=nunder+1;END IF;END LOOP;
 FOR r IN 2..14 LOOP IF ac[r]=2 THEN np:=np+1;ELSIF ac[r]=3 THEN nt:=nt+1;ELSIF ac[r]=4 THEN nq:=nq+1;END IF;END LOOP;
 FOR i IN 1..4 LOOP maxs:=greatest(maxs,sc[i]);maxbs:=greatest(maxbs,bs[i]);END LOOP;
 FOREACH card IN ARRAY cards LOOP IF sc[card%4+1]>=5 THEN flushrank:=greatest(flushrank,card/4+2);END IF;END LOOP;
 FOR top IN 5..14 LOOP hits:=0;FOR wr IN top-4..top LOOP r:=CASE WHEN wr=1 THEN 14 ELSE wr END;IF ac[r]>0 THEN hits:=hits+1;END IF;END LOOP;sw:=greatest(sw,hits);IF hits=5 THEN st:=greatest(st,top);END IF;END LOOP;
 f:=jsonb_build_object('hhigh',hr[1],'hlow',hr[2],'hgap',hr[1]-hr[2],'hpocket',(hr[1]=hr[2])::integer,'hsuited',(own[1]%4=own[2]%4)::integer,'nover',nover,'nunder',nunder,'matches',matches,'maxsuit',maxs,'boardmaxsuit',maxbs,'span',br[1]-br[n],'npairs',np,'ntrips',nt,'nquads',nq,'straightwindow',sw,'straighttop',st,'flushrank',flushrank,'holesuitboard0',bs[own[1]%4+1],'holesuitboard1',bs[own[2]%4+1],'depth',(ctx->>'depth_bucket')::integer,'tablesize',(ctx->>'table_size')::integer,'potbb',public.fn_gto_v31_public215_f64(scenario->>'pot_chips_f64')/public.fn_gto_v31_public215_f64(scenario->>'chips_per_bb_f64'),'stackbb',public.fn_gto_v31_public215_f64(scenario->>'effective_stack_chips_f64')/public.fn_gto_v31_public215_f64(scenario->>'chips_per_bb_f64'),'rakepct',public.fn_gto_v31_public215_f64(scenario#>>'{rake_f64,0}'),'rakecap',public.fn_gto_v31_public215_f64(scenario#>>'{rake_f64,1}'));
 FOR i IN 1..n LOOP f:=f||jsonb_build_object('boardrank'||(i-1),br[i]);END LOOP;
 FOR r IN 2..14 LOOP f:=f||jsonb_build_object('boardcount'||r,bc[r],'allcount'||r,ac[r]);END LOOP;
 FOR k,val IN SELECT key,value FROM jsonb_each(ctx) LOOP IF k NOT IN('texture_class','depth_bucket','table_size') THEN f:=f||jsonb_build_object(k||'='||(val#>>'{}'),1);END IF;END LOOP;
 f:=f||jsonb_build_object('iprange='||(scenario->>'ip_range_checksum'),1,'ooprange='||(scenario->>'oop_range_checksum'),1);
 FOREACH k IN ARRAY prior LOOP out:=array_append(out,COALESCE((f->>k)::double precision,0));END LOOP;
 v:=public.fn_gto_v31_board_relative_key_v2(p_combo,p_board)::jsonb;IF v IS NULL THEN RAISE EXCEPTION 'public215 V2 geometry missing';END IF;
 out:=out||ARRAY[(v->>1)::double precision,(v->>2)::double precision];FOR i IN 0..8 LOOP out:=array_append(out,((v->>2)::integer=i)::integer::double precision);END LOOP;
 FOR i IN 0..4 LOOP out:=array_append(out,COALESCE((v#>>ARRAY['3',i::text])::double precision,-1));END LOOP;out:=array_append(out,jsonb_array_length(v->3)::double precision);
 FOR i IN 0..1 LOOP FOR j IN 0..2 LOOP out:=array_append(out,COALESCE((v#>>ARRAY['4',i::text,j::text])::double precision,-1));END LOOP;END LOOP;
 out:=out||ARRAY[(v->>5)::boolean::integer::double precision,(v->>6)::double precision,(v->>7)::double precision];
 FOR i IN 0..3 LOOP FOR j IN 0..3 LOOP out:=array_append(out,COALESCE((v#>>ARRAY['8',i::text,j::text])::double precision,-1));END LOOP;END LOOP;
 FOR i IN 0..3 LOOP out:=array_append(out,jsonb_array_length(v#>ARRAY['8',i::text])::double precision);END LOOP;out:=array_append(out,(v->>9)::double precision);
 FOR i IN 0..4 LOOP FOR j IN 0..2 LOOP out:=array_append(out,COALESCE((v#>>ARRAY['10',i::text,j::text])::double precision,-1));END LOOP;END LOOP;out:=array_append(out,jsonb_array_length(v->10)::double precision);
 FOR i IN 0..1 LOOP out:=array_append(out,(v#>>ARRAY['11',i::text])::double precision);END LOOP;FOR i IN 0..2 LOOP out:=array_append(out,(v#>>ARRAY['12',i::text])::double precision);END LOOP;
 IF cardinality(out)<>181 THEN RAISE EXCEPTION 'public215 base181 shape %',cardinality(out);END IF;RETURN out;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_ratio(numeric,numeric),public.fn_gto_v31_public215_graph(integer[],integer[]),public.fn_gto_v31_public215_base181(integer,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_action_sum(p double precision[])
RETURNS double precision LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE n integer:=cardinality(p);r double precision[];v double precision:=0::double precision;i integer;j integer;
BEGIN
 IF n<1 OR n>16 THEN RAISE EXCEPTION 'public215 action axis';END IF;
 IF n<8 THEN FOR i IN 1..n LOOP v:=v+p[i];END LOOP;RETURN v;END IF;
 r:=p[1:8];i:=9;WHILE i+7<=n LOOP FOR j IN 1..8 LOOP r[j]:=r[j]+p[i+j-1];END LOOP;i:=i+8;END LOOP;
 v:=((r[1]+r[2])+(r[3]+r[4]))+((r[5]+r[6])+(r[7]+r[8]));WHILE i<=n LOOP v:=v+p[i];i:=i+1;END LOOP;RETURN 0::double precision+v;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_infer(p_model jsonb,p_x double precision[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE raw double precision[]:=ARRAY[]::double precision[];freq double precision[]:=ARRAY[]::double precision[];products double precision[]:=ARRAY[]::double precision[];head jsonb;tree jsonb;node jsonb;v double precision;total double precision;prob double precision;policy double precision;ni integer;i integer;a integer;actions jsonb;mix jsonb:='{}';q jsonb:='{}';aid text;
BEGIN
 IF NOT public.fn_gto_v31_public215_model_valid(p_model) OR cardinality(p_x)<>215 OR array_lower(p_x,1)<>1 OR EXISTS(SELECT 1 FROM unnest(p_x)x WHERE x IS NULL OR x::text IN('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'public215 model/feature validity';END IF;
 FOR head IN SELECT value FROM jsonb_array_elements(p_model->'heads') LOOP
  v:=0::double precision;v:=v+public.fn_gto_v31_public215_f64(head->>'baseline_f64');
  FOR tree IN SELECT value FROM jsonb_array_elements(head->'trees') LOOP
   ni:=0;LOOP node:=tree->ni;EXIT WHEN node?'value_f64';IF p_x[(node->>'feature')::integer+1]<=public.fn_gto_v31_public215_f64(node->>'threshold_f64') THEN ni:=(node->>'left')::integer;ELSE ni:=(node->>'right')::integer;END IF;END LOOP;
   v:=v+public.fn_gto_v31_public215_f64(node->>'value_f64');
  END LOOP;
  IF v::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'public215 prediction overflow';END IF;raw:=array_append(raw,v);
 END LOOP;
 actions:=p_model->'action_ids';a:=jsonb_array_length(actions);
 FOR i IN 1..a LOOP v:=raw[1+a+i];IF v<0 THEN v:=0;ELSIF v>1 THEN v:=1;END IF;freq:=array_append(freq,v);END LOOP;
 total:=public.fn_gto_v31_public215_action_sum(freq);IF NOT total>1e-12 OR total::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'public215 empty frequency mass';END IF;
 FOR i IN 1..a LOOP aid:=actions->>(i-1);prob:=freq[i]/total;mix:=mix||jsonb_build_object(aid,prob);q:=q||jsonb_build_object(aid,raw[1+i]);products:=array_append(products,prob*raw[1+i]);END LOOP;
 policy:=CASE WHEN p_model->>'variant'='direct' THEN raw[1] ELSE public.fn_gto_v31_public215_action_sum(products) END;
 IF policy::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'public215 coherent overflow';END IF;
 RETURN jsonb_build_object('policyEvBb',policy,'actionEvsBb',q,'mix',mix);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_action_sum(double precision[]),public.fn_gto_v31_public215_infer(jsonb,double precision[]) FROM PUBLIC,anon,authenticated,service_role;
-- Exact public board/range batch: each finalboard/holding rank computed once.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_dense_wtl(p_board integer[],p_weights numeric[])
RETURNS TABLE(combo integer,current_w numeric,current_t numeric,current_z numeric,terminal_w numeric,terminal_t numeric,terminal_z numeric)
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
 WITH combos AS MATERIALIZED (
  SELECT (b*(b-1)/2+a)::integer i,a,b,p_weights[b*(b-1)/2+a+1]::bigint w
  FROM generate_series(1,51)b CROSS JOIN LATERAL generate_series(0,b-1)a
  WHERE NOT a=ANY(p_board) AND NOT b=ANY(p_board)
 ), runs AS MATERIALIZED (
  SELECT -1 id,p_board board,-1 x,-1 y
  UNION ALL SELECT 0,p_board,-1,-1 WHERE cardinality(p_board)=5
  UNION ALL SELECT a,p_board||a,a,-1 FROM generate_series(0,51)a WHERE cardinality(p_board)=4 AND NOT a=ANY(p_board)
  UNION ALL SELECT a*52+b,p_board||ARRAY[a,b],a,b FROM generate_series(0,51)a CROSS JOIN LATERAL generate_series(a+1,51)b WHERE cardinality(p_board)=3 AND NOT a=ANY(p_board) AND NOT b=ANY(p_board)
 ), scores AS MATERIALIZED (
  SELECT r.id,c.i,c.a,c.b,c.w,public.fn_gto_v31_public215_rank(r.board||ARRAY[c.a,c.b]) score
  FROM runs r JOIN combos c ON c.a<>r.x AND c.a<>r.y AND c.b<>r.x AND c.b<>r.y
 ), global_groups AS MATERIALIZED (
  SELECT id,score,sum(w) w FROM scores GROUP BY id,score
 ), global_cdf AS MATERIALIZED (
  SELECT id,score,coalesce(sum(w) OVER(PARTITION BY id ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) wins,w ties,sum(w) OVER(PARTITION BY id) z FROM global_groups
 ), per_groups AS MATERIALIZED (
  SELECT id,card,score,sum(w)w FROM scores CROSS JOIN LATERAL unnest(ARRAY[a,b])card GROUP BY id,card,score
 ), per_cdf AS MATERIALIZED (
  SELECT id,card,score,coalesce(sum(w) OVER(PARTITION BY id,card ORDER BY score ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)wins,w ties,sum(w) OVER(PARTITION BY id,card) z FROM per_groups
 ), each AS MATERIALIZED (
  SELECT s.id,s.i,g.wins-a.wins-b.wins wins,g.ties-a.ties-b.ties+s.w ties,g.z-a.z-b.z+s.w z
  FROM scores s JOIN global_cdf g ON g.id=s.id AND g.score=s.score
  JOIN per_cdf a ON a.id=s.id AND a.card=s.a AND a.score=s.score
  JOIN per_cdf b ON b.id=s.id AND b.card=s.b AND b.score=s.score
 )
 SELECT i,max(wins)FILTER(WHERE id=-1),max(ties)FILTER(WHERE id=-1),max(z)FILTER(WHERE id=-1),sum(wins)FILTER(WHERE id<>-1),sum(ties)FILTER(WHERE id<>-1),sum(z)FILTER(WHERE id<>-1)
 FROM each GROUP BY i ORDER BY i;
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_dense_wtl(integer[],numeric[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_rank(integer[]),public.fn_gto_v31_public215_wtl(integer[],integer[],numeric[]) FROM PUBLIC,anon,authenticated,service_role;
-- Private compiled numeric arrays: decode/validate once, never repeat JSON parsing per heldout holding.
CREATE TYPE public.gto_v31_public215_tree AS (feature smallint[],threshold double precision[],left_child smallint[],right_child smallint[],leaf_value double precision[]);
CREATE TYPE public.gto_v31_public215_head AS (baseline double precision,trees public.gto_v31_public215_tree[]);
CREATE FUNCTION public.fn_gto_v31_public215_compile(p_model jsonb)
RETURNS public.gto_v31_public215_head[] LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE result public.gto_v31_public215_head[]:=ARRAY[]::public.gto_v31_public215_head[];h public.gto_v31_public215_head;t public.gto_v31_public215_tree;head jsonb;tree jsonb;node jsonb;i integer;n integer;
BEGIN
 IF NOT public.fn_gto_v31_public215_model_valid(p_model) THEN RAISE EXCEPTION 'strict numeric public215 model required';END IF;
 FOR head IN SELECT value FROM jsonb_array_elements(p_model->'heads') LOOP
  h.baseline:=public.fn_gto_v31_public215_f64(head->>'baseline_f64');h.trees:=ARRAY[]::public.gto_v31_public215_tree[];
  FOR tree IN SELECT value FROM jsonb_array_elements(head->'trees') LOOP
   n:=jsonb_array_length(tree);t.feature:=array_fill((-1)::smallint,ARRAY[n]);t.threshold:=array_fill(0::double precision,ARRAY[n]);t.left_child:=array_fill(0::smallint,ARRAY[n]);t.right_child:=array_fill(0::smallint,ARRAY[n]);t.leaf_value:=array_fill(0::double precision,ARRAY[n]);
   FOR i IN 0..n-1 LOOP node:=tree->i;
    IF node?'value_f64' THEN t.leaf_value[i+1]:=public.fn_gto_v31_public215_f64(node->>'value_f64');
    ELSE t.feature[i+1]:=(node->>'feature')::smallint;t.threshold[i+1]:=public.fn_gto_v31_public215_f64(node->>'threshold_f64');t.left_child[i+1]:=(node->>'left')::smallint;t.right_child[i+1]:=(node->>'right')::smallint;END IF;
   END LOOP;h.trees:=array_append(h.trees,t);
  END LOOP;result:=array_append(result,h);
 END LOOP;RETURN result;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_compiled_raw(p_heads public.gto_v31_public215_head[],p_x double precision[])
RETURNS double precision[] LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE h public.gto_v31_public215_head;t public.gto_v31_public215_tree;i integer;v double precision;out double precision[]:=ARRAY[]::double precision[];
BEGIN
 IF cardinality(p_x)<>215 OR array_ndims(p_x)<>1 OR array_lower(p_x,1)<>1 OR EXISTS(SELECT 1 FROM unnest(p_x)x WHERE x IS NULL OR x::text IN('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'public215 finite215 vector';END IF;
 FOREACH h IN ARRAY p_heads LOOP
  v:=0::double precision;v:=v+h.baseline;
  FOREACH t IN ARRAY h.trees LOOP
   i:=1;WHILE t.feature[i]<>-1 LOOP IF p_x[t.feature[i]+1]<=t.threshold[i] THEN i:=t.left_child[i]+1;ELSE i:=t.right_child[i]+1;END IF;END LOOP;v:=v+t.leaf_value[i];
  END LOOP;
  IF v::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'public215 raw prediction overflow';END IF;out:=array_append(out,v);
 END LOOP;RETURN out;
END $fn$;
REVOKE ALL ON TYPE public.gto_v31_public215_tree,public.gto_v31_public215_head FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_compile(jsonb),public.fn_gto_v31_public215_compiled_raw(public.gto_v31_public215_head[],double precision[]) FROM PUBLIC,anon,authenticated,service_role;
-- ADDITIVE PUBLIC MODEL DATA OWNER
-- Nullable representation is the exact immutable legacy matrix contract.
ALTER TABLE public.gto_v31_input_bundles ADD COLUMN policy_representation text CHECK(policy_representation IN('matrix_v2','public_hist215_v1'));
ALTER TABLE public.gto_v31_datasets ADD COLUMN policy_representation text CHECK(policy_representation IN('matrix_v2','public_hist215_v1'));
ALTER TABLE public.gto_v31_runtime_cells ADD COLUMN policy_representation text CHECK(policy_representation IN('matrix_v2','public_hist215_v1')),
 ADD COLUMN public_model jsonb,ADD COLUMN public_template jsonb,ADD COLUMN public_training_provenance jsonb,ADD COLUMN public_model_build_receipt jsonb,
 ADD COLUMN model_checksum text,ADD COLUMN template_checksum text,ADD COLUMN feature_schema_checksum text,ADD COLUMN training_provenance_checksum text,ADD COLUMN model_build_receipt_checksum text,ADD COLUMN sql_physics_checksum text;
CREATE TABLE public.gto_v31_public_physics (
 physics_key text PRIMARY KEY CHECK(physics_key~'^[0-9a-f]{64}$'),
 implementation_checksum text NOT NULL CHECK(implementation_checksum~'^[0-9a-f]{64}$'),
 board_ids integer[] NOT NULL CHECK(cardinality(board_ids) IN(3,4,5)),
 normalized_weights_checksum text NOT NULL CHECK(normalized_weights_checksum~'^[0-9a-f]{64}$'),
 exact_mass_rows jsonb NOT NULL CHECK(jsonb_typeof(exact_mass_rows)='array'),
 physics_checksum text NOT NULL CHECK(physics_checksum~'^[0-9a-f]{64}$'),
 legal_combos integer NOT NULL CHECK(legal_combos IN(1081,1128,1176)),
 prepared_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gto_v31_public_physics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gto_v31_public_physics FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_gto_v31_public215_immutable_physics() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$ BEGIN RAISE EXCEPTION 'derived public physics rows are immutable';END $fn$;
CREATE TRIGGER gto_v31_public_physics_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_public_physics FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_immutable_physics() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_gto_v31_public215_digest(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=public,extensions AS $fn$ SELECT encode(digest(convert_to(public.fn_gto_v31_public215_canonical(p),'UTF8'),'sha256'),'hex') $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_physics_implementation() RETURNS text LANGUAGE sql STABLE SET search_path=public,extensions AS $fn$
 SELECT encode(digest(convert_to(string_agg(pg_get_functiondef(oid),E'\n' ORDER BY oid::regprocedure::text),'UTF8'),'sha256'),'hex') FROM pg_proc WHERE oid IN('public.fn_gto_v31_public215_rank(integer[])'::regprocedure,'public.fn_gto_v31_public215_dense_wtl(integer[],numeric[])'::regprocedure,'public.fn_gto_v31_public215_ratio(numeric,numeric)'::regprocedure)
$fn$;
CREATE FUNCTION public.fn_gto_v31_public215_normalized_weights(p_template jsonb) RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE a numeric[]:=ARRAY[]::numeric[];s numeric:=0;g numeric:=0;x numeric;y numeric;t numeric;v jsonb;i integer;
BEGIN
 IF p_template->>'format'<>'public_hist215_template_v1' OR jsonb_typeof(p_template->'opponent_weights')<>'array' OR jsonb_array_length(p_template->'opponent_weights')<>1326 THEN RAISE EXCEPTION 'exact approved1326 rootweights required';END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p_template->'opponent_weights') LOOP
  IF jsonb_typeof(v)<>'string' OR v#>>'{}'!~'^(0|[1-9][0-9]{0,12})$' THEN RAISE EXCEPTION 'canonical rootweight';END IF;x:=(v#>>'{}')::numeric;
  IF x>1000000000000 THEN RAISE EXCEPTION 'authored rootweight precision';END IF;s:=s+x;a:=array_append(a,x);y:=x;WHILE y<>0 LOOP t:=mod(g,y);g:=y;y:=t;END LOOP;
 END LOOP;
 IF s<=0 OR s>9223372036854775807 THEN RAISE EXCEPTION 'positive bounded rootmass';END IF;
 FOR i IN 1..1326 LOOP a[i]:=div(a[i],g);END LOOP;RETURN a;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_physics_key(p_template jsonb,p_board text[])
RETURNS text LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE ids integer[];weights numeric[];ws jsonb;
BEGIN
 IF cardinality(p_board) NOT IN(3,4,5) OR EXISTS(SELECT 1 FROM unnest(p_board)c WHERE c IS NULL OR c!~'^[2-9TJQKA][cdhs]$') OR (SELECT count(DISTINCT c)FROM unnest(p_board)c)<>cardinality(p_board) THEN RAISE EXCEPTION 'canonical legal public board';END IF;
 SELECT array_agg((strpos('23456789TJQKA',substr(c,1,1))-1)*4+strpos('cdhs',substr(c,2,1))-1 ORDER BY (strpos('23456789TJQKA',substr(c,1,1))-1)*4+strpos('cdhs',substr(c,2,1))-1) INTO ids FROM unnest(p_board)c;
 weights:=public.fn_gto_v31_public215_normalized_weights(p_template);SELECT jsonb_agg(w::text ORDER BY i) INTO ws FROM unnest(weights)WITH ORDINALITY t(w,i);
 RETURN public.fn_gto_v31_public215_digest(jsonb_build_object('format','public_root_wtl_v1','board_ids',ids,'normalized_root_weights',ws,'implementation_checksum',public.fn_gto_v31_public215_physics_implementation()));
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_prepare_math(p_template jsonb,p_board text[])
RETURNS text LANGUAGE plpgsql VOLATILE STRICT SET search_path=public AS $fn$
DECLARE k text;impl text;weights numeric[];ids integer[];rows jsonb;ws jsonb;pc text;count_rows integer;factor integer;expected integer;
BEGIN
 k:=public.fn_gto_v31_public215_physics_key(p_template,p_board);IF EXISTS(SELECT 1 FROM public.gto_v31_public_physics p WHERE p.physics_key=k) THEN RETURN k;END IF;
 impl:=public.fn_gto_v31_public215_physics_implementation();weights:=public.fn_gto_v31_public215_normalized_weights(p_template);
 SELECT array_agg((strpos('23456789TJQKA',substr(c,1,1))-1)*4+strpos('cdhs',substr(c,2,1))-1 ORDER BY (strpos('23456789TJQKA',substr(c,1,1))-1)*4+strpos('cdhs',substr(c,2,1))-1) INTO ids FROM unnest(p_board)c;
 factor:=CASE cardinality(ids) WHEN 3 THEN 990 WHEN 4 THEN 44 ELSE 1 END;expected:=CASE cardinality(ids) WHEN 3 THEN 1176 WHEN 4 THEN 1128 ELSE 1081 END;
 SELECT count(*),jsonb_agg(jsonb_build_array(combo,current_w::text,current_t::text,(current_z-current_w-current_t)::text,current_z::text,terminal_w::text,terminal_t::text,(terminal_z-terminal_w-terminal_t)::text,terminal_z::text) ORDER BY combo)
 INTO count_rows,rows FROM public.fn_gto_v31_public215_dense_wtl(ids,weights)
 WHERE current_z>0 AND current_w>=0 AND current_t>=0 AND current_w+current_t<=current_z AND terminal_z=current_z*factor AND terminal_w>=0 AND terminal_t>=0 AND terminal_w+terminal_t<=terminal_z;
 IF count_rows<>expected THEN RAISE EXCEPTION 'complete legal-combo public physics required (including zero-training-weight holes)';END IF;
 SELECT jsonb_agg(w::text ORDER BY i) INTO ws FROM unnest(weights)WITH ORDINALITY t(w,i);pc:=public.fn_gto_v31_public215_digest(jsonb_build_object('physics_key',k,'rows',rows));
 INSERT INTO public.gto_v31_public_physics(physics_key,implementation_checksum,board_ids,normalized_weights_checksum,exact_mass_rows,physics_checksum,legal_combos)VALUES(k,impl,ids,public.fn_gto_v31_public215_digest(ws),rows,pc,count_rows) ON CONFLICT DO NOTHING;
 RETURN k;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_prepare_public_physics(p_dataset_id uuid,p_cell_key_checksum text,p_board text[])
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='240s' SET lock_timeout='1s' AS $fn$
DECLARE c public.gto_v31_runtime_cells%ROWTYPE;d public.gto_v31_datasets%ROWTYPE;
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'service_role required';END IF;
 SELECT * INTO STRICT d FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id;
 IF d.state NOT IN('building','evaluating','candidate','active') OR d.policy_representation<>'public_hist215_v1' OR NOT EXISTS(SELECT 1 FROM public.gto_v31_input_bundles b WHERE b.input_bundle_id=d.input_bundle_id AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum) THEN RAISE EXCEPTION 'immutable approved model dataset required';END IF;
 SELECT * INTO STRICT c FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND cell_key_checksum=p_cell_key_checksum AND policy_representation='public_hist215_v1';
 IF public.fn_gto_v31_public215_digest(c.public_template)<>c.template_checksum OR c.public_template->'context' IS DISTINCT FROM (SELECT x FROM jsonb_array_elements(d.declared_coverage)x WHERE x=c.public_template->'context' LIMIT 1) THEN RAISE EXCEPTION 'sealed approved public template required';END IF;
 RETURN public.fn_gto_v31_public215_prepare_audit(c,p_board);
END $fn$;
-- Audit-only derived predictions. The engine never serves these as runtime matrices.
CREATE TABLE public.gto_v31_public_model_compiled(model_checksum text NOT NULL,encoding_checksum text NOT NULL,heads public.gto_v31_public215_head[] NOT NULL,PRIMARY KEY(model_checksum,encoding_checksum));
CREATE TABLE public.gto_v31_public_model_audits(
 audit_key text PRIMARY KEY,physics_key text NOT NULL,model_checksum text NOT NULL,template_checksum text NOT NULL,encoding_checksum text NOT NULL,
 chronological_board text[] NOT NULL,legal_combos integer NOT NULL,audit_checksum text NOT NULL,prepared_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.gto_v31_public_model_audit_combos(
 audit_key text NOT NULL REFERENCES public.gto_v31_public_model_audits(audit_key) DEFERRABLE INITIALLY DEFERRED,combo integer NOT NULL CHECK(combo BETWEEN 0 AND 1325),
 features double precision[] NOT NULL CHECK(cardinality(features)=215),raw_heads double precision[] NOT NULL,
 policy_ev double precision NOT NULL,action_evs double precision[] NOT NULL,frequencies double precision[] NOT NULL,
 PRIMARY KEY(audit_key,combo)
);
ALTER TABLE public.gto_v31_public_model_compiled ENABLE ROW LEVEL SECURITY;ALTER TABLE public.gto_v31_public_model_audits ENABLE ROW LEVEL SECURITY;ALTER TABLE public.gto_v31_public_model_audit_combos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gto_v31_public_model_compiled,public.gto_v31_public_model_audits,public.gto_v31_public_model_audit_combos FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER gto_v31_public_model_compiled_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_public_model_compiled FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
CREATE TRIGGER gto_v31_public_model_audits_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_public_model_audits FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
CREATE TRIGGER gto_v31_public_model_audit_combos_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_public_model_audit_combos FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
CREATE FUNCTION public.fn_gto_v31_public215_bits(p double precision[]) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$ SELECT jsonb_agg(encode(float8send(x),'hex') ORDER BY i)FROM unnest(p)WITH ORDINALITY t(x,i) $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_normalize(p_variant text,p_count integer,p_raw double precision[])
RETURNS TABLE(policy_ev double precision,action_evs double precision[],frequencies double precision[]) LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE i integer;v double precision;total double precision;products double precision[]:=ARRAY[]::double precision[];
BEGIN
 IF p_variant NOT IN('direct','coherent') OR p_count NOT BETWEEN 1 AND 16 OR cardinality(p_raw)<>1+2*p_count OR EXISTS(SELECT 1 FROM unnest(p_raw)x WHERE x IS NULL OR x::text IN('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'public215 complete raw heads';END IF;
 action_evs:=p_raw[2:1+p_count];frequencies:=ARRAY[]::double precision[];
 FOR i IN 1..p_count LOOP v:=p_raw[1+p_count+i];IF v<0 THEN v:=0;ELSIF v>1 THEN v:=1;END IF;frequencies:=array_append(frequencies,v);END LOOP;
 total:=public.fn_gto_v31_public215_action_sum(frequencies);IF NOT total>1e-12 THEN RAISE EXCEPTION 'public215 zero normalized frequency mass';END IF;
 FOR i IN 1..p_count LOOP frequencies[i]:=frequencies[i]/total;products:=array_append(products,frequencies[i]*action_evs[i]);END LOOP;
 policy_ev:=CASE WHEN p_variant='direct' THEN p_raw[1] ELSE public.fn_gto_v31_public215_action_sum(products) END;
 IF policy_ev::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'public215 normalized overflow';END IF;RETURN NEXT;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_features(p_combo integer,p_board text,p_template jsonb,p_mass numeric[])
RETURNS double precision[] LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE out double precision[];board integer[]:=ARRAY[]::integer[];own integer[];hi integer;lo integer;i integer;
BEGIN
 IF cardinality(p_mass)<>8 OR p_mass[4]<=0 OR p_mass[8]<=0 OR p_mass[1]+p_mass[2]+p_mass[3]<>p_mass[4] OR p_mass[5]+p_mass[6]+p_mass[7]<>p_mass[8] THEN RAISE EXCEPTION 'independent exact WTL masses required';END IF;
 out:=public.fn_gto_v31_public215_base181(p_combo,p_board,p_template);
 FOR i IN 1..3 LOOP out:=array_append(out,public.fn_gto_v31_public215_ratio(p_mass[i],p_mass[4]));END LOOP;FOR i IN 5..7 LOOP out:=array_append(out,public.fn_gto_v31_public215_ratio(p_mass[i],p_mass[8]));END LOOP;
 hi:=floor((1+sqrt(1+8*p_combo))/2)::integer;WHILE hi*(hi-1)/2>p_combo LOOP hi:=hi-1;END LOOP;WHILE (hi+1)*hi/2<=p_combo LOOP hi:=hi+1;END LOOP;lo:=p_combo-hi*(hi-1)/2;own:=ARRAY[lo,hi];
 FOR i IN 0..length(p_board)/2-1 LOOP board:=array_append(board,(strpos('23456789TJQKA',substr(p_board,2*i+1,1))-1)*4+strpos('cdhs',substr(p_board,2*i+2,1))-1);END LOOP;
 out:=out||public.fn_gto_v31_public215_graph(own,board);IF cardinality(out)<>215 THEN RAISE EXCEPTION 'public215 full feature shape';END IF;RETURN out;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_encoding_implementation() RETURNS text LANGUAGE sql STABLE SET search_path=public,extensions AS $fn$
 SELECT encode(digest(convert_to(string_agg(pg_get_functiondef(oid),E'\n' ORDER BY oid::regprocedure::text),'UTF8'),'sha256'),'hex')FROM pg_proc WHERE oid IN('public.fn_gto_v31_public215_f64(text)'::regprocedure,'public.fn_gto_v31_public215_ratio(numeric,numeric)'::regprocedure,'public.fn_gto_v31_public215_graph(integer[],integer[])'::regprocedure,'public.fn_gto_v31_public215_base181(integer,text,jsonb)'::regprocedure,'public.fn_gto_v31_public215_features(integer,text,jsonb,numeric[])'::regprocedure,'public.fn_gto_v31_public215_compile(jsonb)'::regprocedure,'public.fn_gto_v31_public215_compiled_raw(public.gto_v31_public215_head[],double precision[])'::regprocedure,'public.fn_gto_v31_public215_normalize(text,integer,double precision[])'::regprocedure,'public.fn_gto_v31_public215_action_sum(double precision[])'::regprocedure,'public.fn_gto_v31_board_relative_key_v2(integer,text)'::regprocedure)
$fn$;
CREATE FUNCTION public.fn_gto_v31_public215_audit_key(p_model_checksum text,p_template_checksum text,p_board text[],p_physics_key text) RETURNS text LANGUAGE sql STABLE STRICT SET search_path=public AS $fn$
 SELECT public.fn_gto_v31_public215_digest(jsonb_build_object('format','public_hist215_audit_v1','model_checksum',p_model_checksum,'template_checksum',p_template_checksum,'chronological_board',p_board,'physics_key',p_physics_key,'encoding_checksum',public.fn_gto_v31_public215_encoding_implementation()))
$fn$;
CREATE FUNCTION public.fn_gto_v31_public215_prepare_audit(p_cell public.gto_v31_runtime_cells,p_board text[])
RETURNS text LANGUAGE plpgsql VOLATILE STRICT SET search_path=public AS $fn$
DECLARE physics text;k text;heads public.gto_v31_public215_head[];ph public.gto_v31_public_physics%ROWTYPE;r jsonb;mass numeric[];x double precision[];raw double precision[];norm record;data jsonb:='[]';n integer:=0;dc text;
BEGIN
 IF p_cell.policy_representation<>'public_hist215_v1' OR public.fn_gto_v31_public215_digest(p_cell.public_model)<>p_cell.model_checksum OR public.fn_gto_v31_public215_digest(p_cell.public_template)<>p_cell.template_checksum THEN RAISE EXCEPTION 'immutable genuine model/template required';END IF;
 physics:=public.fn_gto_v31_public215_prepare_math(p_cell.public_template,p_board);k:=public.fn_gto_v31_public215_audit_key(p_cell.model_checksum,p_cell.template_checksum,p_board,physics);
 PERFORM pg_advisory_xact_lock(hashtextextended('v31-public-audit:'||k,0));
 IF EXISTS(SELECT 1 FROM public.gto_v31_public_model_audits a WHERE a.audit_key=k) THEN RETURN k;END IF;
 SELECT * INTO STRICT ph FROM public.gto_v31_public_physics WHERE physics_key=physics;SELECT c.heads INTO heads FROM public.gto_v31_public_model_compiled c WHERE c.model_checksum=p_cell.model_checksum AND c.encoding_checksum=public.fn_gto_v31_public215_encoding_implementation();
 IF heads IS NULL THEN heads:=public.fn_gto_v31_public215_compile(p_cell.public_model);INSERT INTO public.gto_v31_public_model_compiled VALUES(p_cell.model_checksum,public.fn_gto_v31_public215_encoding_implementation(),heads)ON CONFLICT DO NOTHING;END IF;
 -- Private child FK is deferred until its complete immutable parent digest is inserted.
 FOR r IN SELECT value FROM jsonb_array_elements(ph.exact_mass_rows) LOOP
  mass:=ARRAY[(r->>1)::numeric,(r->>2)::numeric,(r->>3)::numeric,(r->>4)::numeric,(r->>5)::numeric,(r->>6)::numeric,(r->>7)::numeric,(r->>8)::numeric];
  x:=public.fn_gto_v31_public215_features((r->>0)::integer,array_to_string(p_board,''),p_cell.public_template,mass);raw:=public.fn_gto_v31_public215_compiled_raw(heads,x);SELECT * INTO STRICT norm FROM public.fn_gto_v31_public215_normalize(p_cell.public_model->>'variant',jsonb_array_length(p_cell.public_model->'action_ids'),raw);
  INSERT INTO public.gto_v31_public_model_audit_combos VALUES(k,(r->>0)::integer,x,raw,norm.policy_ev,norm.action_evs,norm.frequencies);n:=n+1;
 END LOOP;
 IF n<>ph.legal_combos THEN RAISE EXCEPTION 'complete all-legal audit derivation required';END IF;
 SELECT jsonb_agg(jsonb_build_array(combo,public.fn_gto_v31_public215_bits(features),public.fn_gto_v31_public215_bits(raw_heads),encode(float8send(policy_ev),'hex'),public.fn_gto_v31_public215_bits(action_evs),public.fn_gto_v31_public215_bits(frequencies))ORDER BY combo)INTO data FROM public.gto_v31_public_model_audit_combos c WHERE c.audit_key=k;dc:=public.fn_gto_v31_public215_digest(jsonb_build_object('audit_key',k,'derived_rows',data));
 INSERT INTO public.gto_v31_public_model_audits VALUES(k,physics,p_cell.model_checksum,p_cell.template_checksum,public.fn_gto_v31_public215_encoding_implementation(),p_board,n,dc,now());
 RETURN k;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_bits(double precision[]),public.fn_gto_v31_public215_normalize(text,integer,double precision[]),public.fn_gto_v31_public215_features(integer,text,jsonb,numeric[]),public.fn_gto_v31_public215_encoding_implementation(),public.fn_gto_v31_public215_audit_key(text,text,text[],text),public.fn_gto_v31_public215_prepare_audit(public.gto_v31_runtime_cells,text[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_digest(jsonb),public.fn_gto_v31_public215_physics_implementation(),public.fn_gto_v31_public215_normalized_weights(jsonb),public.fn_gto_v31_public215_physics_key(jsonb,text[]),public.fn_gto_v31_public215_prepare_math(jsonb,text[]),public.fn_gto_v31_prepare_public_physics(uuid,text,text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_prepare_public_physics(uuid,text,text[]) TO service_role;
-- Preserve byte-exact legacy function owners/bodies behind private dispatch aliases.
DO $legacy$
DECLARE r record;name text;alias text;definition text;
BEGIN
 FOR r IN SELECT oid,proname,pg_get_function_identity_arguments(oid)args,pg_get_userbyid(proowner)owner FROM pg_proc WHERE oid IN(
 'public.fn_gto_v31_input_bundle_checksum(jsonb)'::regprocedure,'public.ca_gto_v31_approve_input_bundle(jsonb)'::regprocedure,
 'public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure,'public.fn_gto_v31_heldout_metrics(uuid,text)'::regprocedure,
 'public.fn_gto_v31_cell_payload_checksum(jsonb)'::regprocedure,'public.fn_gto_v31_cell_payload_valid(jsonb)'::regprocedure,
 'public.fn_horse_solver_agreement_v31_decision(jsonb)'::regprocedure)
 LOOP
  alias:=r.proname||'_matrix_v2';definition:=pg_get_functiondef(r.oid);
  IF (length(definition)-length(replace(definition,'FUNCTION public.'||r.proname||'(','')))/length('FUNCTION public.'||r.proname||'(')<>1 THEN RAISE EXCEPTION 'legacy function clone anchor differs';END IF;
  EXECUTE replace(definition,'FUNCTION public.'||r.proname||'(','FUNCTION public.'||alias||'(');
  EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO %I',alias,r.args,r.owner);
  EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC,anon,authenticated,service_role',alias,r.args);
 END LOOP;
END $legacy$;
CREATE FUNCTION public.fn_gto_v31_public215_bundle_valid(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE base jsonb;oldfiles jsonb;v_file jsonb;context_entry jsonb;contexts jsonb;protocols jsonb;k text;digest text;previous text:='';identity text;
BEGIN
 IF jsonb_typeof(p)<>'object' OR (SELECT count(*)FROM jsonb_object_keys(p))<>12 OR NOT p?&ARRAY['bundle_key','bundle_version','range_bundle_checksum','source_combo_order_checksum','icm_model_checksum','files','approval_note','feature_contract_version','policy_export_schema','policy_representation','public215_contexts','public215_protocols'] OR p->>'policy_representation'<>'public_hist215_v1' OR p->>'feature_contract_version'<>'holdem-public-hist215-v1' OR p->>'policy_export_schema'<>'smarter-poker.pio-policy.v4' THEN RETURN false;END IF;
 IF jsonb_typeof(p->'files')<>'array' THEN RETURN false;END IF;
 FOR v_file IN SELECT value FROM jsonb_array_elements(p->'files') LOOP
  IF jsonb_typeof(v_file)<>'object' OR (SELECT count(*)FROM jsonb_object_keys(v_file))<>3 OR NOT v_file?&ARRAY['kind','path','checksum'] OR jsonb_typeof(v_file->'kind')<>'string' OR jsonb_typeof(v_file->'path')<>'string' OR jsonb_typeof(v_file->'checksum')<>'string' OR v_file->>'kind' NOT IN('range','combo_order','icm_model','payout_model','scenario_manifest','public215_template','public215_training_recipe','public215_source_partition','public215_runtime_parity_protocol','public215_dependency_lock','public215_physics_protocol','public215_feature_schema') OR v_file->>'path'!~'^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$' OR position('..' IN v_file->>'path')>0 OR('/'||(v_file->>'path')||'/')LIKE '%//%'OR('/'||(v_file->>'path')||'/')LIKE '%/./%' OR v_file->>'checksum'!~'^[0-9a-f]{64}$' OR v_file->>'checksum'=repeat('0',64) THEN RETURN false;END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'path')FROM jsonb_array_elements(p->'files'))<>jsonb_array_length(p->'files') THEN RETURN false;END IF;
 SELECT jsonb_agg(value)INTO oldfiles FROM jsonb_array_elements(p->'files')WHERE value->>'kind' NOT LIKE 'public215_%';
 base:=(p-'policy_representation'-'public215_contexts'-'public215_protocols')||jsonb_build_object('feature_contract_version','holdem-board-relative-v2','files',oldfiles);
 PERFORM public.fn_gto_v31_input_bundle_checksum_matrix_v2(base);
 protocols:=p->'public215_protocols';IF jsonb_typeof(protocols)<>'object' OR (SELECT count(*)FROM jsonb_object_keys(protocols))<>6 OR NOT protocols?&ARRAY['training_recipe','source_partition','runtime_parity_protocol','dependency_lock','physics_protocol','feature_schema'] THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['training_recipe','source_partition','runtime_parity_protocol','dependency_lock','physics_protocol','feature_schema'] LOOP
  IF jsonb_typeof(protocols->k)<>'object' THEN RETURN false;END IF;digest:=public.fn_gto_v31_public215_digest(protocols->k);
  IF (SELECT count(*)FROM jsonb_array_elements(p->'files')f WHERE f->>'kind'='public215_'||k AND f->>'checksum'=digest)<>1 OR(SELECT count(*)FROM jsonb_array_elements(p->'files')f WHERE f->>'kind'='public215_'||k)<>1 THEN RETURN false;END IF;
 END LOOP;
 IF COALESCE(protocols#>>'{training_recipe,whole_variant}','')NOT IN('direct','coherent')OR protocols#>'{training_recipe,parameters}'IS DISTINCT FROM '{"max_iter":100,"max_leaf_nodes":15,"min_samples_leaf":10,"l2_regularization_f64":"4024000000000000","early_stopping":false,"random_state":731}'::jsonb OR jsonb_typeof(protocols#>'{training_recipe,encoder_descriptor}')IS DISTINCT FROM 'object'OR protocols#>>'{training_recipe,encoder_checksum}'IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols#>'{training_recipe,encoder_descriptor}')THEN RETURN false;END IF;
 IF public.fn_gto_v31_public215_digest(protocols->'feature_schema')<>'0ca054f9bb0463bf6a298a80a29cb4b6d9e6bffcc193e4af9d497e2936ec849f' THEN RETURN false;END IF;
 contexts:=p->'public215_contexts';IF jsonb_typeof(contexts)<>'array' OR jsonb_array_length(contexts)<1 THEN RETURN false;END IF;
 FOR context_entry IN SELECT value FROM jsonb_array_elements(contexts) LOOP
  IF jsonb_typeof(context_entry)<>'object' OR (SELECT count(*)FROM jsonb_object_keys(context_entry))<>5 OR NOT context_entry?&ARRAY['context','expected_children','model_action_order','template_checksum','feature_schema_checksum'] OR jsonb_typeof(context_entry->'context')<>'object' OR (SELECT count(*)FROM jsonb_object_keys(context_entry->'context'))<>13 OR context_entry->>'feature_schema_checksum'<>'0ca054f9bb0463bf6a298a80a29cb4b6d9e6bffcc193e4af9d497e2936ec849f' OR context_entry->>'template_checksum'!~'^[0-9a-f]{64}$' THEN RETURN false;END IF;
  IF NOT (context_entry->'context')?&ARRAY['street','game_family','objective','utility_context','table_size','pot_type','hero_position','opponent_position','depth_bucket','texture_class','node_role','facing_kind','facing_size_bucket'] THEN RETURN false;END IF;
  identity:=public.fn_gto_v31_public215_canonical(context_entry->'context');IF identity COLLATE "C"<=previous COLLATE "C" THEN RETURN false;END IF;previous:=identity;
  IF jsonb_typeof(context_entry->'expected_children')<>'array' OR jsonb_array_length(context_entry->'expected_children') NOT BETWEEN 2 AND 16 OR EXISTS(SELECT 1 FROM jsonb_array_elements(context_entry->'expected_children')a WHERE jsonb_typeof(a)<>'string' OR a#>>'{}'!~'^(c|f|b[1-9][0-9]{0,78})$') OR (SELECT count(DISTINCT value)FROM jsonb_array_elements(context_entry->'expected_children'))<>jsonb_array_length(context_entry->'expected_children') THEN RETURN false;END IF;
  IF context_entry->'model_action_order' IS DISTINCT FROM(SELECT jsonb_agg(value ORDER BY value#>>'{}' COLLATE "C")FROM jsonb_array_elements(context_entry->'expected_children'))THEN RETURN false;END IF;
  IF (SELECT count(*)FROM jsonb_array_elements(p->'files')f WHERE f->>'kind'='public215_template' AND f->>'checksum'=context_entry->>'template_checksum')<>1 THEN RETURN false;END IF;
 END LOOP;
 IF (SELECT count(*)FROM jsonb_array_elements(p->'files')f WHERE f->>'kind'='public215_template')<>jsonb_array_length(contexts) THEN RETURN false;END IF;
 PERFORM public.fn_gto_v31_public215_canonical(p-'approval_note');RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_input_bundle_checksum(p_bundle jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE CALLED ON NULL INPUT SET search_path=public,extensions AS $fn$
DECLARE files jsonb;identity jsonb;
BEGIN
 IF p_bundle->>'feature_contract_version'='holdem-public-hist215-v1'AND p_bundle->>'policy_representation'IS DISTINCT FROM 'public_hist215_v1'THEN RAISE EXCEPTION 'public215 feature identity requires explicit approved numeric representation/protocols';END IF;
 IF NOT(p_bundle?'policy_representation') OR p_bundle->'policy_representation'='null'::jsonb OR p_bundle->>'policy_representation'='matrix_v2' THEN RETURN public.fn_gto_v31_input_bundle_checksum_matrix_v2(p_bundle-'policy_representation');END IF;
 IF NOT public.fn_gto_v31_public215_bundle_valid(p_bundle) THEN RAISE EXCEPTION 'complete explicitly approved public215 bundle required';END IF;
 SELECT jsonb_agg(value ORDER BY value->>'kind' COLLATE "C",value->>'path' COLLATE "C",value->>'checksum' COLLATE "C")INTO files FROM jsonb_array_elements(p_bundle->'files')WHERE value->>'kind'<>'scenario_manifest';
 identity:=jsonb_build_object('contract','smarter-poker.horse-solver-v31-input-bundle.v3','bundle_key',p_bundle->'bundle_key','bundle_version',p_bundle->'bundle_version','range_bundle_checksum',p_bundle->'range_bundle_checksum','source_combo_order_checksum',p_bundle->'source_combo_order_checksum','icm_model_checksum',p_bundle->'icm_model_checksum','files',files,'feature_contract_version',p_bundle->'feature_contract_version','policy_export_schema',p_bundle->'policy_export_schema','policy_representation',p_bundle->'policy_representation','public215_contexts',p_bundle->'public215_contexts','public215_protocols',p_bundle->'public215_protocols');RETURN public.fn_gto_v31_public215_digest(identity);
END $fn$;
CREATE OR REPLACE FUNCTION public.ca_gto_v31_approve_input_bundle(p_bundle jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE id uuid;checksum text;actor uuid:=auth.uid();
BEGIN
 IF NOT(p_bundle?'policy_representation') OR p_bundle->'policy_representation'='null'::jsonb OR p_bundle->>'policy_representation'='matrix_v2' THEN RETURN public.ca_gto_v31_approve_input_bundle_matrix_v2(p_bundle-'policy_representation');END IF;
 IF auth.role()<>'authenticated' OR actor IS NULL OR NOT public.fn_is_horse_admin() THEN RAISE EXCEPTION 'admin approval required';END IF;
 checksum:=public.fn_gto_v31_input_bundle_checksum(p_bundle);
 SELECT b.input_bundle_id INTO id FROM public.gto_v31_input_bundles b WHERE b.bundle_checksum=checksum AND b.approval_status='approved' AND b.bundle_manifest=p_bundle;
 IF id IS NOT NULL THEN RETURN id;END IF;
 id:=public.fn_gto_v31_input_bundle_id(checksum);
 INSERT INTO public.gto_v31_input_bundles(input_bundle_id,bundle_key,bundle_checksum,range_bundle_checksum,source_combo_order_checksum,icm_model_checksum,bundle_manifest,approved_by,feature_contract_version,policy_export_schema,policy_representation)
 VALUES(id,p_bundle->>'bundle_key',checksum,p_bundle->>'range_bundle_checksum',p_bundle->>'source_combo_order_checksum',p_bundle->>'icm_model_checksum',p_bundle,actor,'holdem-public-hist215-v1','smarter-poker.pio-policy.v4','public_hist215_v1')ON CONFLICT(input_bundle_id)DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_input_bundles b WHERE b.input_bundle_id=id AND b.bundle_checksum=checksum AND b.approval_status='approved' AND b.bundle_manifest=p_bundle AND b.policy_representation='public_hist215_v1')THEN RAISE EXCEPTION 'approved input identity reused with another payload/status';END IF;RETURN id;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_bundle_valid(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_gto_v31_public215_keys(p jsonb,keys text[])
RETURNS boolean LANGUAGE sql IMMUTABLE CALLED ON NULL INPUT AS $fn$
 SELECT COALESCE(jsonb_typeof(p)='object' AND (SELECT count(*) FROM jsonb_object_keys(p))=cardinality(keys) AND p?&keys,false)
$fn$;
CREATE FUNCTION public.fn_gto_v31_public215_cards(p_board text,p_own jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE CALLED ON NULL INPUT AS $fn$
DECLARE cards text[];card text;lo integer;hi integer;
BEGIN
 IF p_board IS NULL OR p_board!~'^([2-9TJQKA][cdhs]){3,5}$' THEN RETURN false;END IF;
 SELECT array_agg(substring(p_board FROM i FOR 2))INTO cards FROM generate_series(1,length(p_board),2)i;
 IF p_own IS NOT NULL THEN
  IF jsonb_typeof(p_own) IS DISTINCT FROM 'array' OR jsonb_array_length(p_own)<>2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_own)c WHERE jsonb_typeof(c) IS DISTINCT FROM 'string' OR c#>>'{}'!~'^[2-9TJQKA][cdhs]$') THEN RETURN false;END IF;
  lo:=(strpos('23456789TJQKA',left(p_own->>0,1))-1)*4+strpos('cdhs',right(p_own->>0,1))-1;
  hi:=(strpos('23456789TJQKA',left(p_own->>1,1))-1)*4+strpos('cdhs',right(p_own->>1,1))-1;
  IF lo>=hi THEN RETURN false;END IF;cards:=cards||ARRAY[p_own->>0,p_own->>1];
 END IF;
 RETURN cardinality(cards)=(SELECT count(DISTINCT x)FROM unnest(cards)x);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_runtime_protocol_valid(p jsonb,contexts jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE CALLED ON NULL INPUT AS $fn$
DECLARE c jsonb;item jsonb;i integer:=0;board text;
BEGIN
 IF NOT public.fn_gto_v31_public215_keys(p,ARRAY['format','method','clock','platform','node_major','napi_version','native_source_checksum','execution_limit_ms','contexts']) OR p->>'format' IS DISTINCT FROM 'public_hist215_runtime_parity_protocol_v1' OR p->>'method' IS DISTINCT FROM 'cold_public215_features_and_all_heads_v1' OR p->>'clock' IS DISTINCT FROM 'process.hrtime.bigint' OR p->>'platform' IS DISTINCT FROM 'linux' OR p->'node_major' IS DISTINCT FROM '22'::jsonb OR p->'napi_version' IS DISTINCT FROM '8'::jsonb OR p->'execution_limit_ms' IS DISTINCT FROM '8000'::jsonb OR p->>'native_source_checksum' IS DISTINCT FROM '83442cb6604dfaa30ec7ecc6ce38957355609e722b5df85b866365c97f0ccf9b' OR jsonb_typeof(p->'contexts') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'contexts')<>jsonb_array_length(contexts) THEN RETURN false;END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p->'contexts') LOOP
  IF NOT public.fn_gto_v31_public215_keys(c,ARRAY['context','cases']) OR c->'context' IS DISTINCT FROM contexts->i->'context' OR jsonb_typeof(c->'cases') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'cases') NOT BETWEEN 2 AND 32 OR (SELECT count(DISTINCT value)FROM jsonb_array_elements(c->'cases'))<>jsonb_array_length(c->'cases') THEN RETURN false;END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(c->'cases') LOOP
   IF NOT public.fn_gto_v31_public215_keys(item,ARRAY['board','own']) OR jsonb_typeof(item->'board') IS DISTINCT FROM 'string' OR NOT public.fn_gto_v31_public215_cards(item->>'board',item->'own') OR length(item->>'board')<>(CASE c#>>'{context,street}' WHEN 'flop' THEN 6 WHEN 'turn' THEN 8 WHEN 'river' THEN 10 ELSE 0 END) THEN RETURN false;END IF;
  END LOOP;i:=i+1;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_build_receipt(p_cell public.gto_v31_runtime_cells,p_dataset public.gto_v31_datasets,p_bundle public.gto_v31_input_bundles)
RETURNS boolean LANGUAGE plpgsql VOLATILE STRICT SET search_path=public AS $fn$
DECLARE r jsonb:=p_cell.public_model_build_receipt;t jsonb:=p_cell.public_training_provenance;runtime jsonb;cost jsonb;cases jsonb;approved jsonb;item jsonb;actual public.gto_v31_public_model_audit_combos%ROWTYPE;k text;board text[];ownlo integer;ownhi integer;v_combo integer;i integer:=0;physics double precision;inference double precision;maxphysics double precision:=0;maxinference double precision:=0;f text;
BEGIN
 IF NOT public.fn_gto_v31_public215_keys(r,ARRAY['format','dataset_id','input_bundle_checksum','model_checksum','training_provenance_checksum','template_checksum','feature_schema_checksum','encoder_checksum','physics_checksum','dependency_lock_checksum','producer_commit','producer_bundle_checksum','runtime','cases','cost']) OR r->>'format' IS DISTINCT FROM 'public_hist215_build_receipt_v1' OR r->>'dataset_id' IS DISTINCT FROM p_dataset.dataset_id::text OR r->>'input_bundle_checksum' IS DISTINCT FROM p_bundle.bundle_checksum OR r->>'model_checksum' IS DISTINCT FROM p_cell.model_checksum OR r->>'training_provenance_checksum' IS DISTINCT FROM p_cell.training_provenance_checksum OR r->>'template_checksum' IS DISTINCT FROM p_cell.template_checksum OR r->>'feature_schema_checksum' IS DISTINCT FROM p_cell.feature_schema_checksum OR public.fn_gto_v31_public215_digest(r) IS DISTINCT FROM p_cell.model_build_receipt_checksum THEN RETURN false;END IF;
 FOREACH f IN ARRAY ARRAY['encoder_checksum','physics_checksum','dependency_lock_checksum','producer_commit','producer_bundle_checksum'] LOOP IF r->f IS DISTINCT FROM t->f THEN RETURN false;END IF;END LOOP;
 runtime:=r->'runtime';cost:=r->'cost';cases:=r->'cases';
 IF NOT public.fn_gto_v31_public215_keys(runtime,ARRAY['node_version','platform','arch','napi_version','native_source_checksum','native_binary_checksum']) OR jsonb_typeof(runtime->'node_version') IS DISTINCT FROM 'string' OR runtime->>'node_version'!~'^v?22\.[0-9]+\.[0-9]+$' OR runtime->>'platform' IS DISTINCT FROM 'linux' OR COALESCE(runtime->>'arch','') NOT IN('x64','arm64') OR runtime->'napi_version' IS DISTINCT FROM '8'::jsonb OR runtime->>'native_source_checksum' IS DISTINCT FROM '83442cb6604dfaa30ec7ecc6ce38957355609e722b5df85b866365c97f0ccf9b' OR COALESCE(runtime->>'native_binary_checksum','')!~'^[0-9a-f]{64}$' OR runtime->>'native_binary_checksum'=repeat('0',64) THEN RETURN false;END IF;
 SELECT value->'cases' INTO approved FROM jsonb_array_elements(p_bundle.bundle_manifest#>'{public215_protocols,runtime_parity_protocol,contexts}') WHERE value->'context'=p_cell.public_template->'context';
 IF approved IS NULL OR jsonb_typeof(cases) IS DISTINCT FROM 'array' OR jsonb_array_length(cases)<>jsonb_array_length(approved) OR jsonb_array_length(cases) NOT BETWEEN 2 AND 32 THEN RETURN false;END IF;
 IF NOT public.fn_gto_v31_public215_keys(cost,ARRAY['method','clock','cold_cases','max_physics_ms_f64','max_inference_ms_f64','execution_limit_ms','model_bytes','head_count']) OR cost->>'method' IS DISTINCT FROM 'cold_public215_features_and_all_heads_v1' OR cost->>'clock' IS DISTINCT FROM 'process.hrtime.bigint' OR cost->'cold_cases' IS DISTINCT FROM to_jsonb(jsonb_array_length(cases)) OR cost->'execution_limit_ms' IS DISTINCT FROM '8000'::jsonb OR cost->'model_bytes' IS DISTINCT FROM to_jsonb(octet_length(public.fn_gto_v31_public215_canonical(p_cell.public_model))) OR cost->'head_count' IS DISTINCT FROM to_jsonb(jsonb_array_length(p_cell.public_model->'heads')) THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(cases) LOOP
  IF NOT public.fn_gto_v31_public215_keys(item,ARRAY['board','own','features_f64','raw_heads_f64','policy_ev_f64','Q_f64','frequency_f64','physics_ms_f64','inference_ms_f64']) OR (item-'features_f64'-'raw_heads_f64'-'policy_ev_f64'-'Q_f64'-'frequency_f64'-'physics_ms_f64'-'inference_ms_f64') IS DISTINCT FROM approved->i OR NOT public.fn_gto_v31_public215_cards(item->>'board',item->'own') THEN RETURN false;END IF;
  IF jsonb_typeof(item->'physics_ms_f64') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'inference_ms_f64') IS DISTINCT FROM 'string' THEN RETURN false;END IF;physics:=public.fn_gto_v31_public215_f64(item->>'physics_ms_f64');inference:=public.fn_gto_v31_public215_f64(item->>'inference_ms_f64');IF physics<=0 OR inference<physics OR inference>8000 THEN RETURN false;END IF;maxphysics:=greatest(maxphysics,physics);maxinference:=greatest(maxinference,inference);
  SELECT array_agg(substring(item->>'board' FROM j FOR 2)ORDER BY j)INTO board FROM generate_series(1,length(item->>'board'),2)j;
  ownlo:=(strpos('23456789TJQKA',left(item#>>'{own,0}',1))-1)*4+strpos('cdhs',right(item#>>'{own,0}',1))-1;ownhi:=(strpos('23456789TJQKA',left(item#>>'{own,1}',1))-1)*4+strpos('cdhs',right(item#>>'{own,1}',1))-1;v_combo:=ownhi*(ownhi-1)/2+ownlo;
  k:=public.fn_gto_v31_public215_prepare_audit(p_cell,board);SELECT * INTO STRICT actual FROM public.gto_v31_public_model_audit_combos WHERE audit_key=k AND public.gto_v31_public_model_audit_combos.combo=v_combo;
  IF public.fn_gto_v31_public215_bits(actual.features) IS DISTINCT FROM item->'features_f64' OR public.fn_gto_v31_public215_bits(actual.raw_heads) IS DISTINCT FROM item->'raw_heads_f64' OR encode(float8send(actual.policy_ev),'hex') IS DISTINCT FROM item->>'policy_ev_f64' OR public.fn_gto_v31_public215_bits(actual.action_evs) IS DISTINCT FROM item->'Q_f64' OR public.fn_gto_v31_public215_bits(actual.frequencies) IS DISTINCT FROM item->'frequency_f64' THEN RETURN false;END IF;i:=i+1;
 END LOOP;
 RETURN encode(float8send(maxphysics),'hex')=cost->>'max_physics_ms_f64' AND encode(float8send(maxinference),'hex')=cost->>'max_inference_ms_f64';
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_keys(jsonb,text[]),public.fn_gto_v31_public215_cards(text,jsonb),public.fn_gto_v31_public215_runtime_protocol_valid(jsonb,jsonb),public.fn_gto_v31_public215_build_receipt(public.gto_v31_runtime_cells,public.gto_v31_datasets,public.gto_v31_input_bundles) FROM PUBLIC,anon,authenticated,service_role;
-- Genuine dataset source census. Every admitted artifact and every node is checked;
-- a failed checksum/contract is an error, never a filtering predicate.
CREATE FUNCTION public.fn_gto_v31_public215_context(p jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
 SELECT jsonb_object_agg(k,p->k)FROM unnest(ARRAY['street','game_family','objective','utility_context','table_size','pot_type','hero_position','opponent_position','depth_bucket','texture_class','node_role','facing_kind','facing_size_bucket'])k
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_context(jsonb)FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_gto_v31_public215_rank_signature(p_board text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE ranks text;
BEGIN
 IF NOT public.fn_gto_v31_public215_cards(p_board)THEN RAISE EXCEPTION 'invalid public rank-group board';END IF;
 SELECT string_agg(substring(p_board FROM j FOR 1),'' ORDER BY strpos('23456789TJQKA',substring(p_board FROM j FOR 1)),j)INTO ranks FROM generate_series(1,length(p_board),2)j;RETURN(length(p_board)/2)::text||':'||ranks;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_rank_signature(text)FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_gto_v31_public215_sources(p_dataset public.gto_v31_datasets)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE artifact record;node jsonb;result jsonb:='[]';
BEGIN
 FOR artifact IN SELECT a.source_row_id,a.machine_id,a.source_artifact_checksum,s.scenario_hash,s.strategy_matrix_v2,s.quality_status,s.audited_at,s.source_artifact_checksum AS actual_checksum FROM public.gto_v31_source_artifacts a JOIN public.solved_spots_gold s ON s.id=a.source_row_id WHERE a.dataset_id=p_dataset.dataset_id ORDER BY a.source_row_id LOOP
  IF artifact.quality_status IS DISTINCT FROM 'validated' OR artifact.audited_at IS NULL OR artifact.actual_checksum IS DISTINCT FROM artifact.source_artifact_checksum OR artifact.source_artifact_checksum IS DISTINCT FROM public.fn_gto_v31_source_artifact_checksum(artifact.scenario_hash,artifact.strategy_matrix_v2) THEN RAISE EXCEPTION 'genuine source artifact checksum/validation required';END IF;
  FOR node IN SELECT value FROM jsonb_array_elements(artifact.strategy_matrix_v2->'nodes') LOOP
   node:=public.fn_gto_v31_assert_source_contract(node,p_dataset.policy_export_schema,p_dataset.icm_model_checksum);
   result:=result||jsonb_build_array(jsonb_build_object('source_row_id',artifact.source_row_id,'machine_id',artifact.machine_id,'artifact_checksum',artifact.source_artifact_checksum,'source_node',node->>'node','board',node#>>'{node_context,board}','node_checksum',node->>'node_checksum','context',public.fn_gto_v31_public215_context(node->'node_context')));
  END LOOP;
 END LOOP;
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'source_row_id' COLLATE "C",value->>'source_node' COLLATE "C"),'[]')INTO result FROM jsonb_array_elements(result);
 IF (SELECT count(DISTINCT jsonb_build_array(value->'source_row_id',value->'source_node'))FROM jsonb_array_elements(result))<>jsonb_array_length(result) THEN RAISE EXCEPTION 'duplicate source identities';END IF;RETURN result;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_provenance_valid(p_cell public.gto_v31_runtime_cells,p_dataset public.gto_v31_datasets,p_bundle public.gto_v31_input_bundles,p_sources jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE t jsonb:=p_cell.public_training_provenance;protocols jsonb:=p_bundle.bundle_manifest->'public215_protocols';partition jsonb:=protocols->'source_partition';global_sources jsonb;cell_sources jsonb;groups jsonb;expected_groups jsonb;entry jsonb;context jsonb:=p_cell.public_template->'context';i integer;source jsonb;lastkey text:='';key text;k text;
BEGIN
 IF NOT public.fn_gto_v31_public215_keys(t,ARRAY['format','approved_input_bundle_id','input_bundle_checksum','manifest_checksum','capture_receipt_checksum','training_recipe_checksum','source_partition_checksum','producer_commit','producer_bundle_checksum','solver_binary_checksum','range_bundle_checksum','icm_model_checksum','feature_schema_checksum','encoder_checksum','physics_checksum','dependency_lock_checksum','runtime_parity_protocol_checksum','whole_variant','parameters','machine_id','source_count','artifact_count','board_count','sources']) OR t->>'format' IS DISTINCT FROM 'public_hist215_training_v1' OR t->>'approved_input_bundle_id' IS DISTINCT FROM p_dataset.input_bundle_id::text OR t->>'input_bundle_checksum' IS DISTINCT FROM p_dataset.input_bundle_checksum OR t->>'manifest_checksum' IS DISTINCT FROM p_dataset.manifest_checksum OR t->>'producer_commit' IS DISTINCT FROM p_dataset.pipeline_commit OR t->>'producer_bundle_checksum' IS DISTINCT FROM p_dataset.pipeline_bundle_checksum OR t->>'solver_binary_checksum' IS DISTINCT FROM p_dataset.solver_binary_checksum OR t->>'range_bundle_checksum' IS DISTINCT FROM p_dataset.range_bundle_checksum OR t->>'icm_model_checksum' IS DISTINCT FROM p_dataset.icm_model_checksum OR t->>'feature_schema_checksum' IS DISTINCT FROM p_cell.feature_schema_checksum OR t->>'machine_id' IS DISTINCT FROM 'M1' OR t->>'whole_variant' IS DISTINCT FROM p_cell.public_model->>'variant' OR t->'whole_variant'IS DISTINCT FROM protocols#>'{training_recipe,whole_variant}' OR t->'parameters'IS DISTINCT FROM protocols#>'{training_recipe,parameters}' OR t->'parameters' IS DISTINCT FROM '{"max_iter":100,"max_leaf_nodes":15,"min_samples_leaf":10,"l2_regularization_f64":"4024000000000000","early_stopping":false,"random_state":731}'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['training_recipe','source_partition','dependency_lock','runtime_parity_protocol'] LOOP IF t->>(k||'_checksum') IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols->k) THEN RETURN false;END IF;END LOOP;
 IF t->>'physics_checksum' IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols->'physics_protocol') OR t->>'encoder_checksum' IS DISTINCT FROM protocols#>>'{training_recipe,encoder_checksum}' OR t->>'encoder_checksum' IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols#>'{training_recipe,encoder_descriptor}') OR COALESCE(t->>'encoder_checksum','')!~'^[0-9a-f]{64}$' THEN RETURN false;END IF;
 IF partition->>'format' IS DISTINCT FROM 'public_hist215_source_partition_protocol_v1' OR jsonb_typeof(partition->'training_contexts') IS DISTINCT FROM 'array' OR jsonb_array_length(partition->'training_contexts')<>jsonb_array_length(p_bundle.bundle_manifest->'public215_contexts') THEN RETURN false;END IF;
 -- All M1 sources must be exactly the complete preapproved public training groups.
 -- Unknown future M2 boards/labels are deliberately absent from this digest.
 FOR entry IN SELECT value FROM jsonb_array_elements(partition->'training_contexts') LOOP
  IF (SELECT count(DISTINCT value->'context')FROM jsonb_array_elements(partition->'training_contexts'))<>jsonb_array_length(partition->'training_contexts') THEN RETURN false;END IF;
  IF jsonb_typeof(entry->'rank_signatures') IS DISTINCT FROM 'array' OR jsonb_array_length(entry->'rank_signatures')<>57 OR (SELECT count(DISTINCT value)FROM jsonb_array_elements(entry->'rank_signatures'))<>57 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_bundle.bundle_manifest->'public215_contexts')c WHERE c->'context'=entry->'context') THEN RETURN false;END IF;
  SELECT jsonb_agg(sig ORDER BY sig COLLATE "C")INTO groups FROM(SELECT public.fn_gto_v31_public215_rank_signature(value->>'board')sig FROM jsonb_array_elements(p_sources) WHERE value->>'machine_id'='M1' AND value->'context'=entry->'context')q;
  SELECT jsonb_agg(value ORDER BY value#>>'{}' COLLATE "C")INTO expected_groups FROM jsonb_array_elements(entry->'rank_signatures');IF groups IS DISTINCT FROM expected_groups THEN RETURN false;END IF;
 END LOOP;
 IF (SELECT count(*)FROM jsonb_array_elements(p_sources) WHERE value->>'machine_id'='M1')<>57*jsonb_array_length(partition->'training_contexts') THEN RETURN false;END IF;
 SELECT jsonb_agg(value-'machine_id'-'context' ORDER BY value->>'source_row_id' COLLATE "C",value->>'source_node' COLLATE "C")INTO global_sources FROM jsonb_array_elements(p_sources)WHERE value->>'machine_id'='M1';
 IF t->>'capture_receipt_checksum' IS DISTINCT FROM public.fn_gto_v31_public215_digest(global_sources) THEN RETURN false;END IF;
 SELECT jsonb_agg(value-'machine_id'-'context' ORDER BY value->>'source_row_id' COLLATE "C",value->>'source_node' COLLATE "C")INTO cell_sources FROM jsonb_array_elements(p_sources) WHERE value->>'machine_id'='M1' AND value->'context'=context;
 IF cell_sources IS NULL OR t->'sources' IS DISTINCT FROM cell_sources OR t->'source_count' IS DISTINCT FROM to_jsonb(jsonb_array_length(cell_sources)) OR t->'artifact_count' IS DISTINCT FROM(SELECT to_jsonb(count(DISTINCT value->>'source_row_id'))FROM jsonb_array_elements(cell_sources)) OR t->'board_count' IS DISTINCT FROM(SELECT to_jsonb(count(DISTINCT value->>'board'))FROM jsonb_array_elements(cell_sources)) THEN RETURN false;END IF;
 RETURN public.fn_gto_v31_public215_digest(t)=p_cell.training_provenance_checksum;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_sources(public.gto_v31_datasets),public.fn_gto_v31_public215_provenance_valid(public.gto_v31_runtime_cells,public.gto_v31_datasets,public.gto_v31_input_bundles,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- New public215 has an explicit feature identity; it can never enter a matrix key path.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_identity(p_version text)RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 IF p_version IS NULL THEN RETURN '{}';END IF;
 IF p_version NOT IN('rank-suit-count-v1','holdem-board-relative-v2','holdem-public-hist215-v1') THEN RAISE EXCEPTION 'unknown feature contract version';END IF;RETURN jsonb_build_object('feature_contract_version',p_version);
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_request_valid(p_request jsonb)RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $fn$
 SELECT COALESCE(NOT(p_request?'feature_contract_version')OR(jsonb_typeof(p_request->'feature_contract_version')='string'AND p_request->>'feature_contract_version' IN('rank-suit-count-v1','holdem-board-relative-v2','holdem-public-hist215-v1')),false)
$fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_key(p_combo integer,p_board text,p_version text)RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 PERFORM public.fn_gto_v31_feature_identity(p_version);IF p_version='holdem-public-hist215-v1' THEN RAISE EXCEPTION 'public215 requires chronological public state and sealed numeric model; matrix keys are not model input';END IF;
 IF p_version='holdem-board-relative-v2' THEN RETURN public.fn_gto_v31_board_relative_key_v2(p_combo,p_board);END IF;RETURN public.fn_gto_v31_hand_key(p_combo,p_board);
END $fn$;
DO $columns$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['gto_v31_input_bundles','gto_v31_datasets','gto_v31_runtime_cells'] LOOP
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,t||'_feature_contract_version_check');
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK(feature_contract_version IN(''rank-suit-count-v1'',''holdem-board-relative-v2'',''holdem-public-hist215-v1''))',t,t||'_feature_contract_version_check');
 END LOOP;
END $columns$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_feature_binding_immutable()RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
 IF NEW.feature_contract_version IS DISTINCT FROM OLD.feature_contract_version OR NEW.policy_export_schema IS DISTINCT FROM OLD.policy_export_schema OR NEW.policy_representation IS DISTINCT FROM OLD.policy_representation THEN RAISE EXCEPTION 'feature, policy and representation bindings are immutable';END IF;RETURN NEW;
END $fn$;
-- A guarded request-body edit preserves registration authorization, old request shape,
-- approved bundle checks, owner/ACL and identity. Representation comes from approval.
CREATE FUNCTION pg_temp.public215_replace(body text,anchor text,replacement text)
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
 IF anchor='' OR (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'public215 exact source anchor missing/duplicated: %',anchor;END IF;RETURN replace(body,anchor,replacement);
END $fn$;
DO $registration$
DECLARE body text;
BEGIN
 body:=pg_get_functiondef('public.fn_gto_v31_register_dataset(jsonb)'::regprocedure);
 body:=pg_temp.public215_replace(body,'quality_gates, feature_contract_version, policy_export_schema','quality_gates, feature_contract_version, policy_export_schema,policy_representation');
 body:=pg_temp.public215_replace(body,'v_gates,p_dataset->>''feature_contract_version'',p_dataset->>''policy_export_schema''','v_gates,p_dataset->>''feature_contract_version'',p_dataset->>''policy_export_schema'',v_bundle.policy_representation');
 body:=pg_temp.public215_replace(body,'  INSERT INTO public.gto_v31_datasets (',$patch$  IF v_bundle.policy_representation='public_hist215_v1' AND(
    public.fn_gto_v31_public215_bundle_valid(v_bundle.bundle_manifest) IS NOT TRUE OR
    public.fn_gto_v31_public215_runtime_protocol_valid(v_bundle.bundle_manifest#>'{public215_protocols,runtime_parity_protocol}',v_bundle.bundle_manifest->'public215_contexts') IS NOT TRUE OR
    (SELECT jsonb_agg(value->'context' ORDER BY public.fn_gto_v31_public215_canonical(value->'context') COLLATE "C")FROM jsonb_array_elements(v_bundle.bundle_manifest->'public215_contexts')) IS DISTINCT FROM
    (SELECT jsonb_agg(value ORDER BY public.fn_gto_v31_public215_canonical(value) COLLATE "C")FROM jsonb_array_elements(p_dataset->'declared_coverage'))
  ) THEN RAISE EXCEPTION 'public215 approved context/protocol census differs';END IF;
  INSERT INTO public.gto_v31_datasets ($patch$);
 EXECUTE body;
END $registration$;
CREATE FUNCTION public.fn_gto_v31_public215_template_valid(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE c jsonb:=p->'context';s jsonb:=p->'scenario';k text;v jsonb;pot double precision;stack double precision;bb double precision;
BEGIN
 IF NOT public.fn_gto_v31_public215_keys(p,ARRAY['format','context','root_actor','scenario','opponent_weights']) OR p->>'format' IS DISTINCT FROM 'public_hist215_template_v1' OR COALESCE(p->>'root_actor','') NOT IN('IP','OOP') OR NOT public.fn_gto_v31_public215_keys(c,ARRAY['street','game_family','objective','utility_context','table_size','pot_type','hero_position','opponent_position','depth_bucket','texture_class','node_role','facing_kind','facing_size_bucket']) OR NOT public.fn_gto_v31_json_safe_integer(c->'depth_bucket',1,9007199254740991) OR NOT public.fn_gto_v31_json_safe_integer(c->'table_size',2,10) OR COALESCE(c->>'street','') NOT IN('flop','turn','river') OR jsonb_typeof(c->'texture_class') IS DISTINCT FROM 'string' OR length(c->>'texture_class') NOT BETWEEN 1 AND 96 THEN RETURN false;END IF;
 -- Prior labels are fixed in the full approved descriptor; unknown categories cannot become zeros.
 -- Canonical categories present in the frozen f09 prefix.
 FOR k,v IN SELECT key,value FROM jsonb_each(c) WHERE key NOT IN('depth_bucket','table_size','texture_class') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}')>96 OR NOT (CASE k
   WHEN 'street' THEN v#>>'{}' IN('flop','turn','river') WHEN 'game_family' THEN v#>>'{}' IN('cash','spin','tourney_ev','tourney_icm') WHEN 'objective' THEN v#>>'{}' IN('cash_ev','chip_ev','icm') WHEN 'utility_context' THEN v#>>'{}' IN('bubble','cash_ev','chip_ev','final_table','in_money','ladder','satellite','spin_ladder') WHEN 'hero_position' THEN v#>>'{}' IN('BB','BTN','SB') WHEN 'opponent_position' THEN v#>>'{}' IN('BB','BTN','SB') WHEN 'node_role' THEN v#>>'{}' IN('all_in','barrel','bet_raise','cbet','check_raise','delayed_cbet','facing_bet','facing_raise','open','probe') WHEN 'pot_type' THEN v#>>'{}' IN('3bet','4bet_plus','limped','srp') WHEN 'facing_kind' THEN v#>>'{}' IN('all_in','bet','none','raise') WHEN 'facing_size_bucket' THEN v#>>'{}' IN('all_in','none','small') ELSE false END) THEN RETURN false;END IF;
 END LOOP;
 IF NOT public.fn_gto_v31_public215_keys(s,ARRAY['pot_chips_f64','effective_stack_chips_f64','chips_per_bb_f64','rake_f64','ip_range_checksum','oop_range_checksum']) OR jsonb_typeof(s->'rake_f64') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'rake_f64')<>2 THEN RETURN false;END IF;
 IF COALESCE(s->>'ip_range_checksum','') NOT IN('01b3d4e721b36cf6d8d89fd4941b5ece0e9fd2853f61d1e5f98fbebb3f8f5228','46a1052fd09045ea14940360740c08c8e45786680fb629b992bd6dd60dbb7448','4e711cfed033f777818cc507b6c54c1963959d325916fad5eeb2903076817dea','53b631c6ee33a42f19c276dceef8e49bff0f5d012f3332200301e8e02a6f2e7f','5cfa49e8e307dde353df59384f9af0078989b1f79b610cd6ffce687952817eeb','7297e35f5f97d678bf1c50f2c67f00b676d0da819459b34b566abeb553dfee21') THEN RETURN false;END IF;
 IF COALESCE(s->>'oop_range_checksum','') NOT IN('3ac1e6fa6d92a000680addaf06eab130d2af9467d2e90aceae7cb542b8725c11','4002e2111513d1de3ea6dec8a16bedb436fdd7f9a34ea6f08e2f5e95ee7bba1a','505f32cd9ae2cef66951fcaecc0e8a8fc217ef1d4c0010bc0fe7b57ccf5a417a','5cfa49e8e307dde353df59384f9af0078989b1f79b610cd6ffce687952817eeb','6f7f9456008af722359ef4b8d53353c7e3fbdb94412a2d7cc206526cf2857a1b','85a3cb6615c4547abb4e559d5858dfbdc40eb4938abbf14c1bbf564c027b6c7e') THEN RETURN false;END IF;
 pot:=public.fn_gto_v31_public215_f64(s->>'pot_chips_f64');stack:=public.fn_gto_v31_public215_f64(s->>'effective_stack_chips_f64');bb:=public.fn_gto_v31_public215_f64(s->>'chips_per_bb_f64');IF pot<=0 OR stack<=0 OR bb<=0 OR (pot/bb)::text IN('Infinity','NaN') OR (stack/bb)::text IN('Infinity','NaN') OR public.fn_gto_v31_public215_f64(s#>>'{rake_f64,0}')<0 OR public.fn_gto_v31_public215_f64(s#>>'{rake_f64,1}')<0 THEN RETURN false;END IF;
 PERFORM public.fn_gto_v31_public215_normalized_weights(p);PERFORM public.fn_gto_v31_public215_canonical(p);RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_cell_model_valid(p jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE k text;m jsonb:=p->'public_model';t jsonb:=p->'public_template';
BEGIN
 IF p->>'policy_representation' IS DISTINCT FROM 'public_hist215_v1' OR p->>'feature_contract_version' IS DISTINCT FROM 'holdem-public-hist215-v1' OR p->>'policy_export_schema' IS DISTINCT FROM 'smarter-poker.pio-policy.v4' OR COALESCE(p->'hand_matrix','null')<>'null' OR COALESCE(p->'policy_ev_matrix','null')<>'null' OR COALESCE(p->'action_ev_matrix','null')<>'null' OR public.fn_gto_v31_public215_model_valid(m) IS NOT TRUE OR public.fn_gto_v31_public215_template_valid(t) IS NOT TRUE OR p->>'feature_schema_checksum' IS DISTINCT FROM '0ca054f9bb0463bf6a298a80a29cb4b6d9e6bffcc193e4af9d497e2936ec849f' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['model_checksum','template_checksum','training_provenance_checksum','model_build_receipt_checksum','sql_physics_checksum'] LOOP IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k!~'^[0-9a-f]{64}$' OR p->>k=repeat('0',64) THEN RETURN false;END IF;END LOOP;
 IF public.fn_gto_v31_public215_digest(m) IS DISTINCT FROM p->>'model_checksum' OR public.fn_gto_v31_public215_digest(t) IS DISTINCT FROM p->>'template_checksum' OR public.fn_gto_v31_public215_digest(p->'public_training_provenance') IS DISTINCT FROM p->>'training_provenance_checksum' OR public.fn_gto_v31_public215_digest(p->'public_model_build_receipt') IS DISTINCT FROM p->>'model_build_receipt_checksum' OR m->>'template_sha256' IS DISTINCT FROM p->>'template_checksum' OR m->>'feature_schema_sha256' IS DISTINCT FROM p->>'feature_schema_checksum' OR m->>'provenance_sha256' IS DISTINCT FROM p->>'training_provenance_checksum' OR NOT public.fn_gto_v31_action_specs_valid(p->'action_specs') OR (SELECT count(*)FROM jsonb_object_keys(p->'action_specs'))<>jsonb_array_length(m->'action_ids') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(m->'action_ids')a WHERE NOT(p->'action_specs')?a) THEN RETURN false;END IF;
 FOR k IN SELECT jsonb_object_keys(t->'context') LOOP IF p->k IS DISTINCT FROM t#>ARRAY['context',k] THEN RETURN false;END IF;END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_checksum(p_cell jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE identity jsonb;k text;
BEGIN
 IF COALESCE(p_cell->>'policy_representation','matrix_v2')='matrix_v2' THEN RETURN public.fn_gto_v31_cell_payload_checksum_matrix_v2(p_cell);END IF;
 IF p_cell->>'policy_representation'<>'public_hist215_v1' THEN RAISE EXCEPTION 'unknown policy representation';END IF;
 identity:=jsonb_build_object('contract','public_hist215_cell_payload_v1');
 FOREACH k IN ARRAY ARRAY['cell_key_checksum','street','game_family','objective','utility_context','table_size','pot_type','hero_position','opponent_position','depth_bucket','texture_class','node_role','facing_kind','facing_size_bucket','feature_contract_version','policy_export_schema','policy_representation','action_specs','public_model','public_template','public_training_provenance','public_model_build_receipt','model_checksum','template_checksum','feature_schema_checksum','training_provenance_checksum','model_build_receipt_checksum','sql_physics_checksum','source_rows','train_source_rows','holdout_source_rows','lineage_checksum'] LOOP identity:=identity||jsonb_build_object(k,p_cell->k);END LOOP;
 RETURN public.fn_gto_v31_json_checksum(identity);
END $fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_valid(p_cell jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
BEGIN
 IF COALESCE(p_cell->>'policy_representation','matrix_v2')='matrix_v2' THEN RETURN public.fn_gto_v31_cell_payload_valid_matrix_v2(p_cell);END IF;
 IF public.fn_gto_v31_public215_cell_model_valid(p_cell) IS NOT TRUE OR p_cell->>'cell_key_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_key_checksum(p_cell) OR p_cell->>'cell_payload_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_payload_checksum(p_cell) OR NOT public.fn_gto_v31_json_safe_integer(p_cell->'train_source_rows',1,9007199254740991) OR NOT public.fn_gto_v31_json_safe_integer(p_cell->'holdout_source_rows',1,9007199254740991) OR (p_cell->>'source_rows')::numeric<>(p_cell->>'train_source_rows')::numeric+(p_cell->>'holdout_source_rows')::numeric OR COALESCE(p_cell->>'lineage_checksum','')!~'^[0-9a-f]{64}$' THEN RETURN false;END IF;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_template_valid(jsonb),public.fn_gto_v31_public215_cell_model_valid(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_gto_v31_public215_audit_prediction(p_cell public.gto_v31_runtime_cells,p_board text,p_combo integer)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE board text[];physics text;k text;r public.gto_v31_public_model_audit_combos%ROWTYPE;m jsonb:='{}';q jsonb:='{}';i integer;id text;
BEGIN
 IF p_cell.policy_representation IS DISTINCT FROM 'public_hist215_v1' OR NOT public.fn_gto_v31_public215_cards(p_board) THEN RAISE EXCEPTION 'sealed public215 state required';END IF;
 SELECT array_agg(substring(p_board FROM j FOR 2)ORDER BY j)INTO board FROM generate_series(1,length(p_board),2)j;physics:=public.fn_gto_v31_public215_physics_key(p_cell.public_template,board);k:=public.fn_gto_v31_public215_audit_key(p_cell.model_checksum,p_cell.template_checksum,board,physics);
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_public_model_audits a WHERE a.audit_key=k AND a.model_checksum=p_cell.model_checksum AND a.template_checksum=p_cell.template_checksum AND a.encoding_checksum=public.fn_gto_v31_public215_encoding_implementation()) THEN RAISE EXCEPTION 'independent complete public SQL audit is not prepared';END IF;
 SELECT * INTO STRICT r FROM public.gto_v31_public_model_audit_combos c WHERE c.audit_key=k AND c.combo=p_combo;
 FOR i IN 1..jsonb_array_length(p_cell.public_model->'action_ids') LOOP id:=p_cell.public_model#>>ARRAY['action_ids',(i-1)::text];m:=m||jsonb_build_object(id,r.frequencies[i]);q:=q||jsonb_build_object(id,r.action_evs[i]);END LOOP;
 RETURN jsonb_build_object('policy',r.policy_ev,'mix',m,'Q',q);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_audit_prediction(public.gto_v31_runtime_cells,text,integer) FROM PUBLIC,anon,authenticated,service_role;
-- Retain original metric equations, weights, action census, all missing counters,
-- family restrictions and full v4 assertion. Replace only the policy lookup.
CREATE FUNCTION public.fn_gto_v31_public215_required_audit(p_cell public.gto_v31_runtime_cells,p_board text)
RETURNS text LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE board text[];physics text;k text;
BEGIN
 SELECT array_agg(substring(p_board FROM j FOR 2)ORDER BY j)INTO board FROM generate_series(1,length(p_board),2)j;physics:=public.fn_gto_v31_public215_physics_key(p_cell.public_template,board);k:=public.fn_gto_v31_public215_audit_key(p_cell.model_checksum,p_cell.template_checksum,board,physics);
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_public_model_audits a WHERE a.audit_key=k AND a.model_checksum=p_cell.model_checksum AND a.template_checksum=p_cell.template_checksum AND a.encoding_checksum=public.fn_gto_v31_public215_encoding_implementation())THEN RAISE EXCEPTION 'independent complete public SQL audit is not prepared';END IF;RETURN k;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_required_audit(public.gto_v31_runtime_cells,text)FROM PUBLIC,anon,authenticated,service_role;
DO $metrics$
DECLARE body text;anchor text;
BEGIN
 body:=pg_get_functiondef('public.fn_gto_v31_heldout_metrics_matrix_v2(uuid,text)'::regprocedure);
 body:=pg_temp.public215_replace(body,'FUNCTION public.fn_gto_v31_heldout_metrics_matrix_v2(','FUNCTION public.fn_gto_v31_public215_heldout_metrics(');
 body:=pg_temp.public215_replace(body,'      FROM scored_nodes r','      FROM public_states r');
 body:=pg_temp.public215_replace(body,'  ), holdout AS MATERIALIZED (',
 $patch$  ), public_states AS MATERIALIZED (
    SELECT r.*,c.public_model->'action_ids'AS public_actions,
           public.fn_gto_v31_public215_required_audit(c,r.node#>>'{node_context,board}')AS audit_key
      FROM scored_nodes r JOIN public.gto_v31_runtime_cells c ON c.cell_id=r.cell_id
  ), holdout AS MATERIALIZED ($patch$);
 body:=pg_temp.public215_replace(body,'c.hand_matrix->k.hand_key AS compact_frequencies',
 $patch$(SELECT jsonb_object_agg(a.action,ap.frequencies[a.ord::integer]ORDER BY a.ord)FROM jsonb_array_elements_text(r.public_actions)WITH ORDINALITY a(action,ord))AS compact_frequencies$patch$);
 body:=pg_temp.public215_replace(body,'(c.policy_ev_matrix->>k.hand_key)::numeric AS compact_policy','ap.policy_ev::numeric AS compact_policy');
 -- This private per-source-row grouping identity is not a model feature/key.
 body:=pg_temp.public215_replace(body,'public.fn_gto_v31_feature_key(i,n.value#>>''{node_context,board}'',c.feature_contract_version)','i::text');
 anchor:='      CROSS JOIN LATERAL (SELECT i::text AS hand_key OFFSET 0) k';
 body:=pg_temp.public215_replace(body,anchor,anchor||E'
      LEFT JOIN public.gto_v31_public_model_audit_combos ap ON ap.audit_key=r.audit_key AND ap.combo=i');
 EXECUTE body;
END $metrics$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_heldout_metrics(p_dataset_id uuid,p_game_family text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND policy_representation='public_hist215_v1')THEN RETURN public.fn_gto_v31_public215_heldout_metrics(p_dataset_id,p_game_family);END IF;RETURN public.fn_gto_v31_heldout_metrics_matrix_v2(p_dataset_id,p_game_family);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_heldout_metrics(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
-- The original agreement validator still proves all state/card geometry,
-- seal/dataset identity, legalization, sampling and regret. Only new typed lookup
-- and six additional immutable per-cell identity fields are additive.
DO $decision$
DECLARE body text;
BEGIN
 body:=pg_get_functiondef('public.fn_horse_solver_agreement_v31_decision_matrix_v2(jsonb)'::regprocedure);
 body:=pg_temp.public215_replace(body,'FUNCTION public.fn_horse_solver_agreement_v31_decision_matrix_v2(','FUNCTION public.fn_horse_solver_agreement_v31_public215_decision(');
 body:=pg_temp.public215_replace(body,'public.fn_gto_v31_feature_key(v_combo,v_board_text,v_seal->>''feature_contract_version'')','public.fn_gto_v31_board_relative_key_v2(v_combo,v_board_text)');
 body:=pg_temp.public215_replace(body,'(25 + CASE WHEN v_seal ? ''feature_contract_version'' THEN 1 ELSE 0 END + CASE WHEN v_seal ? ''policy_export_schema'' THEN 1 ELSE 0 END)',
 '(31 + CASE WHEN v_seal ? ''feature_contract_version'' THEN 1 ELSE 0 END + CASE WHEN v_seal ? ''policy_export_schema'' THEN 1 ELSE 0 END)');
 body:=pg_temp.public215_replace(body,'  IF NOT FOUND THEN RETURN false; END IF;'||E'\n\n  IF v_seal->>''dataset_key''',
 $patch$  IF NOT FOUND THEN RETURN false;END IF;
  IF v_cell.policy_representation IS DISTINCT FROM 'public_hist215_v1' OR NOT v_seal?&ARRAY['policy_representation','model_checksum','template_checksum','feature_schema_checksum','training_provenance_checksum','model_build_receipt_checksum'] OR v_seal->>'policy_representation' IS DISTINCT FROM v_cell.policy_representation OR v_seal->>'model_checksum' IS DISTINCT FROM v_cell.model_checksum OR v_seal->>'template_checksum' IS DISTINCT FROM v_cell.template_checksum OR v_seal->>'feature_schema_checksum' IS DISTINCT FROM v_cell.feature_schema_checksum OR v_seal->>'training_provenance_checksum' IS DISTINCT FROM v_cell.training_provenance_checksum OR v_seal->>'model_build_receipt_checksum' IS DISTINCT FROM v_cell.model_build_receipt_checksum OR public.fn_gto_v31_cell_payload_valid(to_jsonb(v_cell)) IS NOT TRUE THEN RETURN false;END IF;

  IF v_seal->>'dataset_key'$patch$);
 body:=pg_temp.public215_replace(body,'v_cell.action_ev_matrix->(p_decision->>''hand_key'')',
 '(public.fn_gto_v31_public215_audit_prediction(v_cell,v_board_text,v_combo))->''Q''');
 body:=pg_temp.public215_replace(body,'     OR NOT (v_cell.hand_matrix ? (p_decision->>''hand_key''))'||E'\n'||'     OR v_distribution<>v_cell.hand_matrix->(p_decision->>''hand_key'')',
 '     OR v_distribution IS DISTINCT FROM(public.fn_gto_v31_public215_audit_prediction(v_cell,v_board_text,v_combo))->''mix''');
 EXECUTE body;
END $decision$;
CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_v31_decision(p_decision jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
 IF p_decision#>>'{source_seal,policy_representation}'='public_hist215_v1' THEN RETURN public.fn_horse_solver_agreement_v31_public215_decision(p_decision);END IF;
 IF p_decision#>>'{source_seal,policy_representation}' IS NOT NULL AND p_decision#>>'{source_seal,policy_representation}'<>'matrix_v2' THEN RETURN false;END IF;
 RETURN public.fn_horse_solver_agreement_v31_decision_matrix_v2(p_decision);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_horse_solver_agreement_v31_public215_decision(jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Existing service-only RPCs retain all original filters/order/security and owners.
-- The new representation appends nullable fields and bounds model transport to
-- one full cell per page; legacy500-row requests are byte/schema-compatible.
CREATE TEMP TABLE public215_rpc_preimages ON COMMIT DROP AS
 SELECT oid,oid::regprocedure::text signature,pg_get_functiondef(oid)definition,proowner,proacl,proconfig,prosecdef,provolatile FROM pg_proc WHERE oid IN('public.fn_gto_v31_active_cells(integer,integer)'::regprocedure,'public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure);
CREATE FUNCTION pg_temp.public215_transport(signature text,definition text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE body text:=definition;lim text;
BEGIN
 body:=pg_temp.public215_replace(body,'policy_export_schema text)',
 'policy_export_schema text, policy_representation text, public_model jsonb, public_template jsonb, public_training_provenance jsonb, public_model_build_receipt jsonb, model_checksum text, template_checksum text, feature_schema_checksum text, training_provenance_checksum text, model_build_receipt_checksum text)');
 body:=pg_temp.public215_replace(body,'c.action_ev_matrix,d.feature_contract_version,d.policy_export_schema',
 'c.action_ev_matrix,d.feature_contract_version,d.policy_export_schema,c.policy_representation,c.public_model,c.public_template,c.public_training_provenance,c.public_model_build_receipt,c.model_checksum,c.template_checksum,c.feature_schema_checksum,c.training_provenance_checksum,c.model_build_receipt_checksum');
 body:=pg_temp.public215_replace(body,'b.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema',
 'b.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema AND b.policy_representation IS NOT DISTINCT FROM d.policy_representation');
 body:=pg_temp.public215_replace(body,'c.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema',
 'c.policy_export_schema IS NOT DISTINCT FROM d.policy_export_schema AND c.policy_representation IS NOT DISTINCT FROM d.policy_representation');
 lim:=CASE WHEN signature='fn_gto_v31_active_cells(integer,integer)' THEN 'EXISTS(SELECT 1 FROM public.gto_v31_datasets WHERE state=''active'' AND policy_representation=''public_hist215_v1'')' ELSE 'EXISTS(SELECT 1 FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND policy_representation=''public_hist215_v1'')' END;
 body:=pg_temp.public215_replace(body,'LIMIT greatest(1,least(COALESCE(p_limit,500),500))',
 'LIMIT greatest(1,least(COALESCE(p_limit,500),CASE WHEN '||lim||' THEN 1 ELSE 500 END))');RETURN body;
END $fn$;
DO $rpc$
DECLARE r record;p record;acl record;role_name text;
BEGIN
 IF (SELECT count(*)FROM public215_rpc_preimages)<>2 THEN RAISE EXCEPTION 'original loader RPCs required';END IF;
 FOR r IN SELECT * FROM public215_rpc_preimages LOOP
  -- RESTRICT is explicit: no dependent object can be silently removed.
  EXECUTE 'DROP FUNCTION public.'||r.signature||' RESTRICT';EXECUTE pg_temp.public215_transport(r.signature,r.definition);
  EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I',r.signature,pg_get_userbyid(r.proowner));
  EXECUTE 'REVOKE ALL ON FUNCTION public.'||r.signature||' FROM PUBLIC,anon,authenticated,service_role';
  FOR acl IN SELECT * FROM aclexplode(COALESCE(r.proacl,acldefault('f',r.proowner)))LOOP
   role_name:=CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl.grantee))END;
   EXECUTE 'GRANT '||acl.privilege_type||' ON FUNCTION public.'||r.signature||' TO '||role_name||CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=('public.'||r.signature)::regprocedure;
  IF p.proowner<>r.proowner OR p.proconfig IS DISTINCT FROM r.proconfig OR p.prosecdef<>r.prosecdef OR p.provolatile<>r.provolatile OR EXISTS((SELECT grantee,privilege_type,is_grantable FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))EXCEPT SELECT grantee,privilege_type,is_grantable FROM aclexplode(COALESCE(r.proacl,acldefault('f',r.proowner))))UNION ALL(SELECT grantee,privilege_type,is_grantable FROM aclexplode(COALESCE(r.proacl,acldefault('f',r.proowner)))EXCEPT SELECT grantee,privilege_type,is_grantable FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))))) THEN RAISE EXCEPTION 'RPC owner/ACL/security/config changed';END IF;
 END LOOP;
END $rpc$;
ALTER TABLE public.gto_v31_runtime_cells ALTER COLUMN hand_matrix DROP NOT NULL,ALTER COLUMN policy_ev_matrix DROP NOT NULL,ALTER COLUMN action_ev_matrix DROP NOT NULL;
ALTER TABLE public.gto_v31_runtime_cells DROP CONSTRAINT gto_v31_runtime_cells_hand_keys_match_street_chk,DROP CONSTRAINT gto_v31_runtime_cells_compact_matrices_valid_chk;
ALTER TABLE public.gto_v31_runtime_cells ADD CONSTRAINT gto_v31_runtime_cells_representation_payload_chk CHECK(
 (COALESCE(policy_representation,'matrix_v2')='matrix_v2' AND hand_matrix IS NOT NULL AND policy_ev_matrix IS NOT NULL AND action_ev_matrix IS NOT NULL AND public_model IS NULL AND public_template IS NULL AND public_training_provenance IS NULL AND public_model_build_receipt IS NULL AND model_checksum IS NULL AND template_checksum IS NULL AND feature_schema_checksum IS NULL AND training_provenance_checksum IS NULL AND model_build_receipt_checksum IS NULL AND sql_physics_checksum IS NULL AND public.fn_gto_v31_hand_matrix_valid(hand_matrix,street,feature_contract_version) AND public.fn_gto_v31_compact_matrices_valid(hand_matrix,action_specs,policy_ev_matrix,action_ev_matrix,street,feature_contract_version)) OR
 (policy_representation='public_hist215_v1' AND feature_contract_version='holdem-public-hist215-v1' AND policy_export_schema='smarter-poker.pio-policy.v4' AND hand_matrix IS NULL AND policy_ev_matrix IS NULL AND action_ev_matrix IS NULL AND public_model IS NOT NULL AND public_template IS NOT NULL AND public_training_provenance IS NOT NULL AND public_model_build_receipt IS NOT NULL AND model_checksum IS NOT NULL AND template_checksum IS NOT NULL AND feature_schema_checksum IS NOT NULL AND training_provenance_checksum IS NOT NULL AND model_build_receipt_checksum IS NOT NULL AND sql_physics_checksum IS NOT NULL)
);
CREATE FUNCTION public.fn_gto_v31_public215_cell_immutable()RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
 IF OLD.policy_representation='public_hist215_v1' THEN RAISE EXCEPTION 'numeric model cell and all immutable receipts cannot be rewritten or deleted';END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $fn$;
CREATE TRIGGER gto_v31_public215_cell_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_runtime_cells FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_cell_immutable();
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_cell_immutable() FROM PUBLIC,anon,authenticated,service_role;
-- Cell-source collection remains the original maintained v4-authoritative path.
-- Only matrix aggregation is replaced by strict frozen numeric model admission.
DO $build$
DECLARE body text;start_at integer;end_at integer;anchor text;
BEGIN
 body:=pg_get_functiondef('public.fn_gto_v31_build_cell_matrix_v2(uuid,jsonb)'::regprocedure);
 body:=pg_temp.public215_replace(body,'FUNCTION public.fn_gto_v31_build_cell_matrix_v2(','FUNCTION public.fn_gto_v31_public215_build_cell(');
 body:=pg_temp.public215_replace(body,'  v_dataset public.gto_v31_datasets%ROWTYPE;',
 $patch$  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_envelope jsonb:=p_context;v_bundle public.gto_v31_input_bundles%ROWTYPE;
  v_modelcell public.gto_v31_runtime_cells%ROWTYPE;v_approved jsonb;v_globalsources jsonb;v_board text[];v_item jsonb;$patch$);
 body:=pg_temp.public215_replace(body,E'BEGIN\n  IF COALESCE(auth.role()',
 $patch$BEGIN
  IF NOT public.fn_gto_v31_public215_keys(v_envelope,ARRAY['context','policy_representation','public_model','public_template','public_training_provenance','public_model_build_receipt','model_checksum','template_checksum','feature_schema_checksum','training_provenance_checksum','model_build_receipt_checksum']) OR v_envelope->>'policy_representation' IS DISTINCT FROM 'public_hist215_v1' OR octet_length(public.fn_gto_v31_public215_canonical(v_envelope))>4194304 THEN RAISE EXCEPTION 'complete bounded public215 model envelope required';END IF;
  p_context:=v_envelope->'context';
  IF COALESCE(auth.role()$patch$);
 -- Existing-cell retries must match the same frozen bytes after source assertions.
 body:=pg_temp.public215_replace(body,'  IF v_existing_checksum IS NOT NULL THEN RETURN v_existing_checksum; END IF;',
 $patch$  IF v_existing_checksum IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.cell_key_checksum=v_existing_checksum AND c.policy_representation='public_hist215_v1' AND c.public_model=v_envelope->'public_model' AND c.public_template=v_envelope->'public_template' AND c.public_training_provenance=v_envelope->'public_training_provenance' AND c.public_model_build_receipt=v_envelope->'public_model_build_receipt' AND c.model_checksum=v_envelope->>'model_checksum' AND c.template_checksum=v_envelope->>'template_checksum' AND c.feature_schema_checksum=v_envelope->>'feature_schema_checksum' AND c.training_provenance_checksum=v_envelope->>'training_provenance_checksum' AND c.model_build_receipt_checksum=v_envelope->>'model_build_receipt_checksum') THEN RAISE EXCEPTION 'numeric cell retry has different frozen model bytes';END IF;
    RETURN v_existing_checksum;
  END IF;$patch$);
 anchor:=$anchor$  WITH source_nodes AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(v_source_nodes) AS n(
      source_row_id uuid,machine_id text,source_artifact_checksum text,node jsonb,split text
    )
  ), combo_observations AS MATERIALIZED ($anchor$;
 start_at:=strpos(body,anchor);end_at:=strpos(body,'  v_cell:=p_context||');
 IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'numeric aggregation exact source boundary differs';END IF;
 body:=left(body,start_at-1)||$patch$  IF v_train_rows<>57 OR v_holdout_rows<>8 THEN RAISE EXCEPTION 'numeric cell requires complete approved57 M1 and selected8 M2 nodes';END IF;
  SELECT * INTO STRICT v_bundle FROM public.gto_v31_input_bundles WHERE input_bundle_id=v_dataset.input_bundle_id AND approval_status='approved' AND bundle_checksum=v_dataset.input_bundle_checksum;
  IF v_dataset.policy_representation IS DISTINCT FROM 'public_hist215_v1' OR public.fn_gto_v31_public215_bundle_valid(v_bundle.bundle_manifest) IS NOT TRUE OR public.fn_gto_v31_public215_runtime_protocol_valid(v_bundle.bundle_manifest#>'{public215_protocols,runtime_parity_protocol}',v_bundle.bundle_manifest->'public215_contexts') IS NOT TRUE THEN RAISE EXCEPTION 'approved public215 bundle and protocol required';END IF;
  SELECT value INTO STRICT v_approved FROM jsonb_array_elements(v_bundle.bundle_manifest->'public215_contexts')WHERE value->'context'=p_context;
  IF v_envelope->'public_model'->'action_ids' IS DISTINCT FROM v_approved->'model_action_order' OR v_envelope->>'template_checksum' IS DISTINCT FROM v_approved->>'template_checksum' OR v_envelope->>'feature_schema_checksum' IS DISTINCT FROM v_approved->>'feature_schema_checksum' THEN RAISE EXCEPTION 'model action order/template/schema differs from independently approved source target';END IF;
  v_cell:=p_context||v_envelope-'context'||public.fn_gto_v31_feature_identity(v_dataset.feature_contract_version)||public.fn_gto_v31_policy_identity(v_dataset.policy_export_schema)||jsonb_build_object('hand_matrix',NULL,'policy_ev_matrix',NULL,'action_ev_matrix',NULL,'action_specs',v_specs,'source_rows',v_source_rows,'train_source_rows',v_train_rows,'holdout_source_rows',v_holdout_rows,'lineage_checksum',v_lineage,'sql_physics_checksum',public.fn_gto_v31_public215_digest(jsonb_build_object('physics',public.fn_gto_v31_public215_physics_implementation(),'encoding',public.fn_gto_v31_public215_encoding_implementation())));
  v_cell:=v_cell||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(v_cell));v_cell:=v_cell||jsonb_build_object('cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(v_cell));
  IF public.fn_gto_v31_cell_payload_valid(v_cell) IS NOT TRUE THEN RAISE EXCEPTION 'strict frozen numeric model payload failed validation';END IF;
  v_modelcell:=jsonb_populate_record(NULL::public.gto_v31_runtime_cells,v_cell||jsonb_build_object('dataset_id',p_dataset_id));
  v_globalsources:=public.fn_gto_v31_public215_sources(v_dataset);
  IF EXISTS(WITH ranks AS MATERIALIZED(SELECT value->>'machine_id' machine,public.fn_gto_v31_public215_rank_signature(value->>'board')signature FROM jsonb_array_elements(v_globalsources))SELECT 1 FROM ranks GROUP BY signature HAVING count(DISTINCT machine)>1)THEN RAISE EXCEPTION 'new215 global rank-group train/holdout overlap';END IF;
  IF public.fn_gto_v31_public215_provenance_valid(v_modelcell,v_dataset,v_bundle,v_globalsources) IS NOT TRUE THEN RAISE EXCEPTION 'numeric model provenance does not reconcile genuine complete approved M1 capture';END IF;
  -- Exact M2 selected subset/frozen model authority is checked by source admission.
  -- Admission is added below with the explicit authenticated selection envelope.
  IF public.fn_gto_v31_public215_build_receipt(v_modelcell,v_dataset,v_bundle) IS NOT TRUE THEN RAISE EXCEPTION 'independent public215 SQL/all-head runtime parity or bounded Linux cost receipt failed';END IF;

$patch$||substring(body FROM end_at);
 start_at:=strpos(body,'  v_cell:=p_context||public.fn_gto_v31_feature_identity');end_at:=strpos(body,'  INSERT INTO public.gto_v31_runtime_cells (');
 IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'old matrix payload exact source boundary differs';END IF;
 body:=left(body,start_at-1)||substring(body FROM end_at);
 body:=pg_temp.public215_replace(body,'holdout_source_rows,cell_payload_checksum,lineage_checksum,feature_contract_version,policy_export_schema',
 'holdout_source_rows,cell_payload_checksum,lineage_checksum,feature_contract_version,policy_export_schema,policy_representation,public_model,public_template,public_training_provenance,public_model_build_receipt,model_checksum,template_checksum,feature_schema_checksum,training_provenance_checksum,model_build_receipt_checksum,sql_physics_checksum');
 body:=pg_temp.public215_replace(body,'v_cell->>''lineage_checksum'',v_dataset.feature_contract_version,v_dataset.policy_export_schema',
 'v_cell->>''lineage_checksum'',v_dataset.feature_contract_version,v_dataset.policy_export_schema,''public_hist215_v1'',v_modelcell.public_model,v_modelcell.public_template,v_modelcell.public_training_provenance,v_modelcell.public_model_build_receipt,v_modelcell.model_checksum,v_modelcell.template_checksum,v_modelcell.feature_schema_checksum,v_modelcell.training_provenance_checksum,v_modelcell.model_build_receipt_checksum,v_modelcell.sql_physics_checksum');
 -- JSON null is not an empty matrix; storage requires genuine SQL NULL.
 body:=pg_temp.public215_replace(body,'v_cell->''hand_matrix'',','NULL,');
 body:=pg_temp.public215_replace(body,'v_cell->''policy_ev_matrix'',v_cell->''action_ev_matrix'',','NULL,NULL,');
 EXECUTE body;
END $build$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_build_cell(p_dataset_id uuid,p_context jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions SET statement_timeout='240s' SET lock_timeout='1s' AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND policy_representation='public_hist215_v1') THEN RETURN public.fn_gto_v31_public215_build_cell(p_dataset_id,p_context);END IF;RETURN public.fn_gto_v31_build_cell_matrix_v2(p_dataset_id,p_context);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_build_cell(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_gto_v31_public215_dataset_models_valid(p_dataset public.gto_v31_datasets)
RETURNS boolean LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE n integer;authority integer;physics text;
BEGIN
 IF p_dataset.policy_representation IS DISTINCT FROM 'public_hist215_v1' THEN RETURN true;END IF;
 physics:=public.fn_gto_v31_public215_digest(jsonb_build_object('physics',public.fn_gto_v31_public215_physics_implementation(),'encoding',public.fn_gto_v31_public215_encoding_implementation()));
 SELECT count(*),count(DISTINCT jsonb_build_object('variant',public_model->'variant','capture',public_training_provenance->'capture_receipt_checksum','recipe',public_training_provenance->'training_recipe_checksum','partition',public_training_provenance->'source_partition_checksum','protocol',public_training_provenance->'runtime_parity_protocol_checksum','encoder',public_training_provenance->'encoder_checksum','physics',public_training_provenance->'physics_checksum','lock',public_training_provenance->'dependency_lock_checksum','parameters',public_training_provenance->'parameters'))INTO n,authority FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset.dataset_id;
 IF n<>jsonb_array_length(p_dataset.declared_coverage) OR authority<>1 OR EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset.dataset_id AND(c.policy_representation IS DISTINCT FROM p_dataset.policy_representation OR c.sql_physics_checksum IS DISTINCT FROM physics OR public.fn_gto_v31_cell_payload_valid(to_jsonb(c)) IS NOT TRUE))THEN RETURN false;END IF;RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_dataset_models_valid(public.gto_v31_datasets) FROM PUBLIC,anon,authenticated,service_role;
DO $seal$
DECLARE sig text;body text;anchor text;
BEGIN
 FOREACH sig IN ARRAY ARRAY['fn_gto_v31_seal_build(uuid)','fn_gto_v31_promote_dataset(uuid)'] LOOP
  body:=pg_get_functiondef(('public.'||sig)::regprocedure);
  anchor:=CASE sig WHEN 'fn_gto_v31_seal_build(uuid)' THEN '  IF NOT FOUND THEN RAISE EXCEPTION ''dataset is not building''; END IF;' ELSE '  IF NOT FOUND THEN RAISE EXCEPTION ''dataset is not a candidate''; END IF;' END;
  body:=pg_temp.public215_replace(body,anchor,anchor||E'\n  IF public.fn_gto_v31_public215_dataset_models_valid(v_dataset) IS NOT TRUE THEN RAISE EXCEPTION ''numeric model set/source authority/SQL implementation differs from immutable dataset'';END IF;');EXECUTE body;
 END LOOP;
END $seal$;
-- The seed opening is transient at authenticated admission. No function accepts
-- precomputed HMAC scores as evidence, and no seed is persisted or returned.
CREATE FUNCTION public.fn_gto_v31_public215_selected(p_protocol jsonb,p_seed text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public,extensions AS $fn$
DECLARE c jsonb;candidate jsonb;selected jsonb:='[]';ranked jsonb;ctx text;key bytea;sig text;message bytea;item jsonb;
BEGIN
 IF p_seed!~'^[0-9a-f]{64}$' OR NOT public.fn_gto_v31_public215_keys(p_protocol,ARRAY['format','boards_per_context','context_id_rule','contexts','domain_separator','physical_board_rule','rank_message','rank_order','rank_selection','reservation_checksum','seed_bytes','seed_commitment_checksum']) OR p_protocol->>'format' IS DISTINCT FROM 'public_hist215_m2_selection_protocol_v1' OR p_protocol->'boards_per_context' IS DISTINCT FROM '8'::jsonb OR p_protocol->'seed_bytes' IS DISTINCT FROM '32'::jsonb OR p_protocol->>'domain_separator' IS DISTINCT FROM 'public_hist215_m2_rank_v1' OR p_protocol->>'rank_selection' IS DISTINCT FROM 'hmac_sha256_context_rank_first8_v1' OR jsonb_typeof(p_protocol->'contexts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_protocol->'contexts')<1 THEN RAISE EXCEPTION 'invalid approved blind selection protocol/opening';END IF;
 key:=decode(p_seed,'hex');IF encode(digest(key,'sha256'),'hex') IS DISTINCT FROM p_protocol->>'seed_commitment_checksum' THEN RAISE EXCEPTION 'blind selection commitment does not match';END IF;
 IF (SELECT count(DISTINCT value->>'context_id')FROM jsonb_array_elements(p_protocol->'contexts'))<>jsonb_array_length(p_protocol->'contexts') THEN RAISE EXCEPTION 'duplicate blind selection context';END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_protocol->'contexts') LOOP
  IF NOT public.fn_gto_v31_public215_keys(c,ARRAY['context','context_id','candidates']) OR c->>'context_id' IS DISTINCT FROM public.fn_gto_v31_public215_digest(c->'context') OR jsonb_typeof(c->'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'candidates')<8 OR (SELECT count(DISTINCT value->>'rank_signature')FROM jsonb_array_elements(c->'candidates'))<>jsonb_array_length(c->'candidates') THEN RAISE EXCEPTION 'invalid blind candidate domain';END IF;
  FOR candidate IN SELECT value FROM jsonb_array_elements(c->'candidates') LOOP
   IF NOT public.fn_gto_v31_public215_keys(candidate,ARRAY['board','rank_signature']) OR NOT public.fn_gto_v31_public215_cards(candidate->>'board') OR candidate->>'rank_signature' IS DISTINCT FROM public.fn_gto_v31_public215_rank_signature(candidate->>'board') OR length(candidate->>'board')<>(CASE c#>>'{context,street}' WHEN 'flop' THEN 6 WHEN 'turn' THEN 8 WHEN 'river' THEN 10 ELSE 0 END) THEN RAISE EXCEPTION 'invalid canonical blind candidate board';END IF;
  END LOOP;
  SELECT jsonb_agg(value ORDER BY score,value->>'rank_signature' COLLATE "C")INTO ranked FROM(SELECT value,hmac(convert_to(p_protocol->>'domain_separator','UTF8')||decode('00','hex')||convert_to(c->>'context_id','UTF8')||decode('00','hex')||convert_to(value->>'rank_signature','UTF8'),key,'sha256')score FROM jsonb_array_elements(c->'candidates')ORDER BY score,value->>'rank_signature' COLLATE "C" LIMIT 8)q;
  FOR item IN SELECT value FROM jsonb_array_elements(ranked)LOOP selected:=selected||jsonb_build_array(jsonb_build_object('context_id',c->>'context_id','rank_signature',item->>'rank_signature','board',item->>'board'));END LOOP;
 END LOOP;
 SELECT jsonb_agg(value ORDER BY value->>'context_id' COLLATE "C",value->>'rank_signature' COLLATE "C")INTO selected FROM jsonb_array_elements(selected);RETURN selected;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_selected(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
-- Metadata is derived only after canonical source admission in the same request.
-- This avoids repeatedly decoding all1326 arrays to construct a global capture.
CREATE TABLE public.gto_v31_public_source_journal(
 dataset_id uuid NOT NULL,source_row_id uuid NOT NULL,source_node text NOT NULL,
 context jsonb NOT NULL,board text NOT NULL,node_checksum text NOT NULL,
 artifact_checksum text NOT NULL,machine_id text NOT NULL CHECK(machine_id IN('M1','M2')),
 PRIMARY KEY(dataset_id,source_row_id,source_node)
);
ALTER TABLE public.gto_v31_public_source_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gto_v31_public_source_journal FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER gto_v31_public_source_journal_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_public_source_journal FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_sources(p_dataset public.gto_v31_datasets)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE result jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a LEFT JOIN public.solved_spots_gold s ON s.id=a.source_row_id WHERE a.dataset_id=p_dataset.dataset_id AND(s.id IS NULL OR s.quality_status IS DISTINCT FROM 'validated'OR s.audited_at IS NULL OR s.source_artifact_checksum IS DISTINCT FROM a.source_artifact_checksum OR s.machine_id IS DISTINCT FROM a.machine_id OR s.solver_version IS DISTINCT FROM p_dataset.solver_version OR s.solver_binary_checksum IS DISTINCT FROM p_dataset.solver_binary_checksum OR s.pipeline_commit IS DISTINCT FROM p_dataset.pipeline_commit OR s.pipeline_bundle_checksum IS DISTINCT FROM p_dataset.pipeline_bundle_checksum OR s.manifest_version::text IS DISTINCT FROM p_dataset.manifest_version OR s.manifest_checksum IS DISTINCT FROM p_dataset.manifest_checksum))THEN RAISE EXCEPTION 'canonical approved source metadata is missing/quarantined/changed';END IF;
 IF EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a LEFT JOIN LATERAL(SELECT count(*)n,min(j.artifact_checksum)lo,max(j.artifact_checksum)hi,min(j.machine_id)machine FROM public.gto_v31_public_source_journal j WHERE j.dataset_id=a.dataset_id AND j.source_row_id=a.source_row_id)x ON true WHERE a.dataset_id=p_dataset.dataset_id AND(x.n<>a.node_count OR x.lo IS DISTINCT FROM a.source_artifact_checksum OR x.hi IS DISTINCT FROM a.source_artifact_checksum OR x.machine IS DISTINCT FROM a.machine_id)) OR EXISTS(SELECT 1 FROM public.gto_v31_public_source_journal j WHERE j.dataset_id=p_dataset.dataset_id AND NOT EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a WHERE a.dataset_id=j.dataset_id AND a.source_row_id=j.source_row_id)) THEN RAISE EXCEPTION 'canonical source metadata journal does not reconcile';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('source_row_id',source_row_id,'source_node',source_node,'board',board,'node_checksum',node_checksum,'artifact_checksum',artifact_checksum,'machine_id',machine_id,'context',context)ORDER BY source_row_id::text COLLATE "C",source_node COLLATE "C"),'[]')INTO result FROM public.gto_v31_public_source_journal WHERE dataset_id=p_dataset.dataset_id;RETURN result;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_capture(p_dataset public.gto_v31_datasets,p_bundle public.gto_v31_input_bundles)
RETURNS text LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE sources jsonb:=public.fn_gto_v31_public215_sources(p_dataset);partition jsonb:=p_bundle.bundle_manifest#>'{public215_protocols,source_partition}';entry jsonb;groups jsonb;expected jsonb;captured jsonb;
BEGIN
 IF partition->>'format' IS DISTINCT FROM 'public_hist215_source_partition_protocol_v1' OR jsonb_typeof(partition->'training_contexts') IS DISTINCT FROM 'array' OR jsonb_array_length(partition->'training_contexts')<>jsonb_array_length(p_bundle.bundle_manifest->'public215_contexts') OR(SELECT count(DISTINCT value->'context')FROM jsonb_array_elements(partition->'training_contexts'))<>jsonb_array_length(partition->'training_contexts') THEN RAISE EXCEPTION 'complete approved source partition required';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(partition->'training_contexts')LOOP
  IF jsonb_typeof(entry->'rank_signatures') IS DISTINCT FROM 'array' OR jsonb_array_length(entry->'rank_signatures')<>57 OR(SELECT count(DISTINCT value)FROM jsonb_array_elements(entry->'rank_signatures'))<>57 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_bundle.bundle_manifest->'public215_contexts')c WHERE c->'context'=entry->'context') THEN RAISE EXCEPTION 'complete approved M1context rank groups required';END IF;
  SELECT jsonb_agg(sig ORDER BY sig COLLATE "C")INTO groups FROM(SELECT public.fn_gto_v31_public215_rank_signature(value->>'board')sig FROM jsonb_array_elements(sources)WHERE value->>'machine_id'='M1' AND value->'context'=entry->'context')q;
  SELECT jsonb_agg(value ORDER BY value#>>'{}' COLLATE "C")INTO expected FROM jsonb_array_elements(entry->'rank_signatures');IF groups IS DISTINCT FROM expected THEN RAISE EXCEPTION 'complete genuine M1 capture does not match frozen partition';END IF;
 END LOOP;
 IF(SELECT count(*)FROM jsonb_array_elements(sources)WHERE value->>'machine_id'='M1')<>57*jsonb_array_length(partition->'training_contexts')THEN RAISE EXCEPTION 'global M1 capture count differs';END IF;
 SELECT jsonb_agg(value-'machine_id'-'context' ORDER BY value->>'source_row_id' COLLATE "C",value->>'source_node' COLLATE "C")INTO captured FROM jsonb_array_elements(sources)WHERE value->>'machine_id'='M1';RETURN public.fn_gto_v31_public215_digest(captured);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_capture(public.gto_v31_datasets,public.gto_v31_input_bundles)FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.gto_v31_public_selections(
 dataset_id uuid PRIMARY KEY,input_bundle_checksum text NOT NULL,
 receipt_checksum text NOT NULL,receipt jsonb NOT NULL,
 capture_checksum text NOT NULL,selected jsonb NOT NULL,frozen_models jsonb NOT NULL
);
ALTER TABLE public.gto_v31_public_selections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gto_v31_public_selections FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER gto_v31_public_selections_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_public_selections FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
CREATE FUNCTION public.fn_gto_v31_public215_selection_receipt(p jsonb,d public.gto_v31_datasets,b public.gto_v31_input_bundles,seed text)
RETURNS boolean LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE protocols jsonb:=b.bundle_manifest->'public215_protocols';expected jsonb;entry jsonb;approved jsonb;previous text:='';identity text;i integer:=0;k text;
BEGIN
 IF NOT public.fn_gto_v31_public215_keys(p,ARRAY['format','dataset_id','input_bundle_checksum','source_partition_checksum','selection_protocol_checksum','seed_commitment_checksum','capture_receipt_checksum','training_recipe_checksum','runtime_parity_protocol_checksum','encoder_checksum','physics_checksum','dependency_lock_checksum','feature_schema_checksum','frozen_models','selected']) OR p->>'format' IS DISTINCT FROM 'public_hist215_m2_selection_receipt_v1' OR p->>'dataset_id' IS DISTINCT FROM d.dataset_id::text OR p->>'input_bundle_checksum' IS DISTINCT FROM d.input_bundle_checksum OR p->>'source_partition_checksum' IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols->'source_partition') OR p->>'selection_protocol_checksum' IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols#>'{source_partition,m2_selection}') OR p->>'seed_commitment_checksum' IS DISTINCT FROM protocols#>>'{source_partition,m2_selection,seed_commitment_checksum}' OR p->>'capture_receipt_checksum' IS DISTINCT FROM(SELECT prep.identity->>'capture_receipt_checksum'FROM public.gto_v31_model_preparations prep WHERE prep.dataset_id=d.dataset_id ORDER BY prep.cell_key_checksum LIMIT 1) OR p->>'feature_schema_checksum' IS DISTINCT FROM '0ca054f9bb0463bf6a298a80a29cb4b6d9e6bffcc193e4af9d497e2936ec849f' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['training_recipe','runtime_parity_protocol','dependency_lock'] LOOP IF p->>(k||'_checksum') IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols->k)THEN RETURN false;END IF;END LOOP;
 IF p->>'encoder_checksum' IS DISTINCT FROM protocols#>>'{training_recipe,encoder_checksum}' OR p->>'encoder_checksum' IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols#>'{training_recipe,encoder_descriptor}') OR p->>'physics_checksum' IS DISTINCT FROM public.fn_gto_v31_public215_digest(protocols->'physics_protocol') THEN RETURN false;END IF;
 IF jsonb_typeof(p->'frozen_models') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'frozen_models')<>jsonb_array_length(b.bundle_manifest->'public215_contexts') THEN RETURN false;END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'frozen_models')LOOP
  IF NOT public.fn_gto_v31_public215_keys(entry,ARRAY['context','model_checksum','model_build_receipt_checksum','template_checksum','training_provenance_checksum']) OR entry->'context' IS DISTINCT FROM b.bundle_manifest->'public215_contexts'->i->'context' OR entry->>'template_checksum' IS DISTINCT FROM b.bundle_manifest->'public215_contexts'->i->>'template_checksum' THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['model_checksum','model_build_receipt_checksum','template_checksum','training_provenance_checksum'] LOOP IF jsonb_typeof(entry->k) IS DISTINCT FROM 'string' OR entry->>k!~'^[0-9a-f]{64}$' OR entry->>k=repeat('0',64)THEN RETURN false;END IF;END LOOP;i:=i+1;
 END LOOP;
 expected:=public.fn_gto_v31_public215_selected(protocols#>'{source_partition,m2_selection}',seed);RETURN p->'selected'=expected;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_selection_receipt(jsonb,public.gto_v31_datasets,public.gto_v31_input_bundles,text)FROM PUBLIC,anon,authenticated,service_role;
-- The existing source validator/checksum machinery is unchanged for legacy and M1.
DO $clone_ingest$
DECLARE body text;owner text;
BEGIN
 body:=pg_get_functiondef('public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)'::regprocedure);SELECT pg_get_userbyid(proowner)INTO owner FROM pg_proc WHERE oid='public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)'::regprocedure;
 body:=pg_temp.public215_replace(body,'FUNCTION public.fn_gto_v31_ingest_source_artifact(','FUNCTION public.fn_gto_v31_ingest_source_artifact_matrix_v2(');EXECUTE body;EXECUTE format('ALTER FUNCTION public.fn_gto_v31_ingest_source_artifact_matrix_v2(uuid,text,jsonb)OWNER TO %I',owner);
 -- The new private M2 branch preserves the same outer7keys and exact v4 nodes,
 -- but canonical artifact identity now includes the two immutable matrix receipts.
 body:=pg_temp.public215_replace(body,'FUNCTION public.fn_gto_v31_ingest_source_artifact_matrix_v2(','FUNCTION public.fn_gto_v31_public215_ingest_m2(');
 body:=pg_temp.public215_replace(body,'(SELECT count(*) FROM jsonb_object_keys(v_matrix))<>3','(SELECT count(*) FROM jsonb_object_keys(v_matrix))<>5');
 body:=pg_temp.public215_replace(body,$anchor$NOT (v_matrix ?& ARRAY['schema','combo_order','nodes'])$anchor$,$anchor$NOT (v_matrix ?& ARRAY['schema','combo_order','nodes','selection_receipt','selection_receipt_checksum'])$anchor$);EXECUTE body;
END $clone_ingest$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_ingest_source_artifact_matrix_v2(uuid,text,jsonb),public.fn_gto_v31_public215_ingest_m2(uuid,text,jsonb)FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_ingest_source_artifact(p_dataset_id uuid,p_machine_id text,p_artifact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE d public.gto_v31_datasets;b public.gto_v31_input_bundles;v_receipt jsonb;receipt_sha text;seed text;result jsonb;persisted jsonb;matrix jsonb;node jsonb;v_source_id uuid;entry jsonb;
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role' AND current_user NOT IN('postgres','supabase_admin')THEN RAISE EXCEPTION 'service_role required';END IF;
 SELECT * INTO STRICT d FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
 IF d.policy_representation IS DISTINCT FROM 'public_hist215_v1' THEN RETURN public.fn_gto_v31_ingest_source_artifact_matrix_v2(p_dataset_id,p_machine_id,p_artifact);END IF;
 SELECT * INTO STRICT b FROM public.gto_v31_input_bundles WHERE input_bundle_id=d.input_bundle_id AND approval_status='approved' AND bundle_checksum=d.input_bundle_checksum;
 IF p_machine_id='M1'AND EXISTS(SELECT 1 FROM public.gto_v31_model_preparations p WHERE p.dataset_id=d.dataset_id)AND NOT EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a WHERE a.dataset_id=d.dataset_id AND a.source_row_id::text=lower(p_artifact->>'id'))THEN RAISE EXCEPTION 'complete M1 source partition is immutable after model preparation';END IF;
 IF p_machine_id='M2' THEN
  IF NOT public.fn_gto_v31_public215_keys(p_artifact,ARRAY['id','scenario_hash','game_family','stack_depth','street','solved_at','strategy_matrix_v2','selection_seed']) OR jsonb_typeof(p_artifact->'selection_seed') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'authenticated blind selection opening required';END IF;
  seed:=p_artifact->>'selection_seed';persisted:=p_artifact-'selection_seed';p_artifact:=NULL;
  matrix:=persisted->'strategy_matrix_v2';v_receipt:=matrix->'selection_receipt';receipt_sha:=matrix->>'selection_receipt_checksum';
  IF NOT public.fn_gto_v31_public215_keys(matrix,ARRAY['schema','combo_order','nodes','selection_receipt','selection_receipt_checksum']) OR receipt_sha IS DISTINCT FROM public.fn_gto_v31_public215_digest(v_receipt) OR public.fn_gto_v31_public215_selection_receipt(v_receipt,d,b,seed) IS NOT TRUE THEN seed:=NULL;RAISE EXCEPTION 'blind selected source v_receipt or opening is invalid';END IF;seed:=NULL;
  INSERT INTO public.gto_v31_public_selections VALUES(d.dataset_id,d.input_bundle_checksum,receipt_sha,v_receipt,v_receipt->>'capture_receipt_checksum',v_receipt->'selected',v_receipt->'frozen_models')ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.gto_v31_public_selections s WHERE s.dataset_id=d.dataset_id AND s.receipt_checksum=receipt_sha AND s.receipt=v_receipt)THEN RAISE EXCEPTION 'frozen blind selection v_receipt changed';END IF;
  FOR node IN SELECT value FROM jsonb_array_elements(matrix->'nodes')LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_receipt->'selected')s WHERE s->>'context_id'=public.fn_gto_v31_public215_digest(public.fn_gto_v31_public215_context(node->'node_context')) AND s->>'board'=node#>>'{node_context,board}' AND s->>'rank_signature'=public.fn_gto_v31_public215_rank_signature(node#>>'{node_context,board}'))THEN RAISE EXCEPTION 'source node is outside the exact committed M2 subset';END IF;
  END LOOP;
  result:=public.fn_gto_v31_public215_ingest_m2(p_dataset_id,p_machine_id,persisted);
 ELSIF p_machine_id='M1' THEN
  IF p_artifact?'selection_seed' OR p_artifact#>'{strategy_matrix_v2,selection_receipt}' IS NOT NULL THEN RAISE EXCEPTION 'M1 cannot carry an M2 opening/v_receipt';END IF;
  result:=public.fn_gto_v31_ingest_source_artifact_matrix_v2(p_dataset_id,p_machine_id,p_artifact);
 ELSE RAISE EXCEPTION 'approved solver machine required';END IF;
 v_source_id:=(result->>'source_row_id')::uuid;
 -- Metadata comes from the SQL-normalized canonical artifact, never the caller.
 FOR node IN SELECT value FROM public.solved_spots_gold s CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes')WHERE s.id=v_source_id LOOP
  INSERT INTO public.gto_v31_public_source_journal VALUES(p_dataset_id,v_source_id,node->>'node',public.fn_gto_v31_public215_context(node->'node_context'),node#>>'{node_context,board}',node->>'node_checksum',result->>'source_artifact_checksum',p_machine_id)ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.gto_v31_public_source_journal j WHERE j.dataset_id=p_dataset_id AND j.source_row_id=v_source_id AND j.source_node=node->>'node' AND j.context=public.fn_gto_v31_public215_context(node->'node_context') AND j.board=node#>>'{node_context,board}' AND j.node_checksum=node->>'node_checksum' AND j.artifact_checksum=result->>'source_artifact_checksum' AND j.machine_id=p_machine_id)THEN RAISE EXCEPTION 'immutable canonical source journal changed';END IF;
 END LOOP;RETURN result;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_selected_complete(d public.gto_v31_datasets)
RETURNS boolean LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE s public.gto_v31_public_selections;actual jsonb;
BEGIN
 SELECT * INTO STRICT s FROM public.gto_v31_public_selections WHERE dataset_id=d.dataset_id AND input_bundle_checksum=d.input_bundle_checksum;
 IF public.fn_gto_v31_public215_digest(s.receipt) IS DISTINCT FROM s.receipt_checksum THEN RETURN false;END IF;
 SELECT jsonb_agg(jsonb_build_object('context_id',public.fn_gto_v31_public215_digest(context),'rank_signature',public.fn_gto_v31_public215_rank_signature(board),'board',board)ORDER BY public.fn_gto_v31_public215_digest(context)COLLATE "C",public.fn_gto_v31_public215_rank_signature(board)COLLATE "C")INTO actual FROM public.gto_v31_public_source_journal WHERE dataset_id=d.dataset_id AND machine_id='M2';
 RETURN actual=s.selected AND jsonb_array_length(actual)=8*jsonb_array_length(d.declared_coverage);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_frozen_model_valid(c public.gto_v31_runtime_cells,d public.gto_v31_datasets)
RETURNS boolean LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE s public.gto_v31_public_selections;model jsonb;key text;
BEGIN
 SELECT * INTO STRICT s FROM public.gto_v31_public_selections WHERE dataset_id=d.dataset_id AND input_bundle_checksum=d.input_bundle_checksum;
 SELECT value INTO STRICT model FROM jsonb_array_elements(s.frozen_models)WHERE value->'context'=c.public_template->'context';
 IF model->>'model_checksum' IS DISTINCT FROM c.model_checksum OR model->>'model_build_receipt_checksum' IS DISTINCT FROM c.model_build_receipt_checksum OR model->>'template_checksum' IS DISTINCT FROM c.template_checksum OR model->>'training_provenance_checksum' IS DISTINCT FROM c.training_provenance_checksum THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['capture_receipt_checksum','training_recipe_checksum','source_partition_checksum','runtime_parity_protocol_checksum','encoder_checksum','physics_checksum','dependency_lock_checksum','feature_schema_checksum']LOOP IF c.public_training_provenance->key IS DISTINCT FROM s.receipt->key THEN RETURN false;END IF;END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_selected_complete(public.gto_v31_datasets),public.fn_gto_v31_public215_frozen_model_valid(public.gto_v31_runtime_cells,public.gto_v31_datasets)FROM PUBLIC,anon,authenticated,service_role;
DO $bind_selection$
DECLARE body text;anchor text;
BEGIN
 body:=pg_get_functiondef('public.fn_gto_v31_public215_build_cell(uuid,jsonb)'::regprocedure);
 anchor:='  -- Exact M2 selected subset/frozen model authority is checked by source admission.'||E'\n  -- Admission is added below with the explicit authenticated selection envelope.';
 body:=pg_temp.public215_replace(body,anchor,$patch$  IF public.fn_gto_v31_public215_selected_complete(v_dataset)IS NOT TRUE OR public.fn_gto_v31_public215_frozen_model_valid(v_modelcell,v_dataset)IS NOT TRUE THEN RAISE EXCEPTION 'complete exact selected M2 subset and frozen pre-opening model identity required';END IF;$patch$);EXECUTE body;
 body:=pg_get_functiondef('public.fn_gto_v31_public215_dataset_models_valid(public.gto_v31_datasets)'::regprocedure);
 anchor:=' IF n<>jsonb_array_length(p_dataset.declared_coverage)';
 body:=pg_temp.public215_replace(body,anchor,' IF public.fn_gto_v31_public215_selected_complete(p_dataset)IS NOT TRUE OR EXISTS(SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset.dataset_id AND public.fn_gto_v31_public215_frozen_model_valid(c,p_dataset)IS NOT TRUE)THEN RETURN false;END IF;'||E'\n'||anchor);EXECUTE body;
END $bind_selection$;
-- Unsealed numeric programs have a separate private owner. Preparation is not a
-- runtime cell, holdout result, evaluation candidate or qualification verdict.
CREATE FUNCTION public.fn_gto_v31_public215_program_identity(p jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('model_checksum',p->>'model_checksum','template_checksum',p->>'template_checksum','feature_schema_checksum',p->>'feature_schema_checksum','training_provenance_checksum',p->>'training_provenance_checksum','variant',p#>>'{public_model,variant}','capture_receipt_checksum',p#>>'{public_training_provenance,capture_receipt_checksum}','training_recipe_checksum',p#>>'{public_training_provenance,training_recipe_checksum}','source_partition_checksum',p#>>'{public_training_provenance,source_partition_checksum}','runtime_parity_protocol_checksum',p#>>'{public_training_provenance,runtime_parity_protocol_checksum}','encoder_checksum',p#>>'{public_training_provenance,encoder_checksum}','physics_checksum',p#>>'{public_training_provenance,physics_checksum}','dependency_lock_checksum',p#>>'{public_training_provenance,dependency_lock_checksum}')
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_program_identity(jsonb)FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.gto_v31_model_preparations(
 dataset_id uuid NOT NULL,cell_key_checksum text NOT NULL,context jsonb NOT NULL,
 program jsonb NOT NULL,identity jsonb NOT NULL CHECK(identity=public.fn_gto_v31_public215_program_identity(program)),action_specs jsonb NOT NULL,train_lineage_checksum text NOT NULL,
 preparation_checksum text NOT NULL,sql_physics_checksum text NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(dataset_id,cell_key_checksum)
);
CREATE TABLE public.gto_v31_model_freezes(
 dataset_id uuid NOT NULL,cell_key_checksum text NOT NULL,
 public_model_build_receipt jsonb NOT NULL,model_build_receipt_checksum text NOT NULL,
 frozen_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(dataset_id,cell_key_checksum)
);
ALTER TABLE public.gto_v31_model_preparations ENABLE ROW LEVEL SECURITY;ALTER TABLE public.gto_v31_model_freezes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gto_v31_model_preparations,public.gto_v31_model_freezes FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER gto_v31_model_preparations_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_model_preparations FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
CREATE TRIGGER gto_v31_model_freezes_immutable BEFORE UPDATE OR DELETE ON public.gto_v31_model_freezes FOR EACH ROW EXECUTE FUNCTION public.fn_gto_v31_public215_immutable_physics();
CREATE FUNCTION public.fn_gto_v31_public215_train_context(d public.gto_v31_datasets,ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SET search_path=public,extensions AS $fn$
DECLARE result jsonb;n integer;variants integer;coherent boolean;specs jsonb;lineage text;
BEGIN
 WITH wanted AS MATERIALIZED(SELECT * FROM public.gto_v31_public_source_journal WHERE dataset_id=d.dataset_id AND machine_id='M1' AND context=ctx),
 artifacts AS MATERIALIZED(SELECT s.id,s.scenario_hash,s.strategy_matrix_v2,s.quality_status,s.audited_at,s.source_artifact_checksum FROM public.solved_spots_gold s WHERE s.id IN(SELECT source_row_id FROM wanted)),
 nodes AS MATERIALIZED(SELECT j.source_row_id,j.source_node,j.node_checksum,public.fn_gto_v31_assert_source_contract(v.value,d.policy_export_schema,d.icm_model_checksum)node FROM wanted j JOIN artifacts a ON a.id=j.source_row_id AND a.quality_status='validated' AND a.audited_at IS NOT NULL AND a.source_artifact_checksum=j.artifact_checksum AND a.source_artifact_checksum=public.fn_gto_v31_source_artifact_checksum(a.scenario_hash,a.strategy_matrix_v2)CROSS JOIN LATERAL jsonb_array_elements(a.strategy_matrix_v2->'nodes')v(value)WHERE v.value->>'node'=j.source_node AND v.value->>'node_checksum'=j.node_checksum)
 SELECT count(*),count(DISTINCT node->'action_specs'),bool_and(public.fn_gto_v31_public215_context(node->'node_context')=ctx),(array_agg(node->'action_specs'))[1],encode(digest(string_agg(source_row_id::text||':'||source_node||':'||node_checksum,''ORDER BY source_row_id::text,source_node),'sha256'),'hex')INTO n,variants,coherent,specs,lineage FROM nodes;
 IF n<>57 OR variants<>1 OR coherent IS NOT TRUE OR public.fn_gto_v31_action_specs_valid(specs)IS NOT TRUE THEN RAISE EXCEPTION 'complete genuine canonical M1 context sources required';END IF;
 RETURN jsonb_build_object('action_specs',specs,'lineage_checksum',lineage);
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_preparation_cell(p public.gto_v31_model_preparations)
RETURNS public.gto_v31_runtime_cells LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $fn$
 SELECT jsonb_populate_record(NULL::public.gto_v31_runtime_cells,p.context||(p.program-'context')||jsonb_build_object('dataset_id',p.dataset_id,'cell_key_checksum',p.cell_key_checksum,'feature_contract_version','holdem-public-hist215-v1','policy_export_schema','smarter-poker.pio-policy.v4','action_specs',p.action_specs,'lineage_checksum',p.train_lineage_checksum,'sql_physics_checksum',p.sql_physics_checksum))
$fn$;
CREATE FUNCTION public.fn_gto_v31_prepare_model(p_dataset_id uuid,p_program jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='240s' SET lock_timeout='1s' AS $fn$
DECLARE d public.gto_v31_datasets;b public.gto_v31_input_bundles;c public.gto_v31_runtime_cells;p public.gto_v31_model_preparations;approved jsonb;source jsonb;digest text;sql_digest text;k text;
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role'AND current_user NOT IN('postgres','supabase_admin')THEN RAISE EXCEPTION 'service_role required';END IF;
 SELECT * INTO STRICT d FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND state='building' AND policy_representation='public_hist215_v1'FOR UPDATE;
 SELECT * INTO STRICT b FROM public.gto_v31_input_bundles WHERE input_bundle_id=d.input_bundle_id AND approval_status='approved'AND bundle_checksum=d.input_bundle_checksum;
 IF NOT public.fn_gto_v31_public215_keys(p_program,ARRAY['context','policy_representation','public_model','public_template','public_training_provenance','model_checksum','template_checksum','feature_schema_checksum','training_provenance_checksum'])OR p_program->>'policy_representation'IS DISTINCT FROM 'public_hist215_v1'OR octet_length(public.fn_gto_v31_public215_canonical(p_program))>4194304 OR public.fn_gto_v31_public215_model_valid(p_program->'public_model')IS NOT TRUE OR public.fn_gto_v31_public215_template_valid(p_program->'public_template')IS NOT TRUE OR p_program->>'feature_schema_checksum'IS DISTINCT FROM '0ca054f9bb0463bf6a298a80a29cb4b6d9e6bffcc193e4af9d497e2936ec849f'OR p_program#>'{public_template,context}'IS DISTINCT FROM p_program->'context' THEN RAISE EXCEPTION 'strict approved numeric preparation program required';END IF;
 FOREACH k IN ARRAY ARRAY['model','template','training_provenance']LOOP IF p_program->>(k||'_checksum')IS DISTINCT FROM public.fn_gto_v31_public215_digest(p_program->('public_'||k))THEN RAISE EXCEPTION 'numeric preparation digest mismatch';END IF;END LOOP;
 IF p_program#>>'{public_model,template_sha256}'IS DISTINCT FROM p_program->>'template_checksum'OR p_program#>>'{public_model,feature_schema_sha256}'IS DISTINCT FROM p_program->>'feature_schema_checksum'OR p_program#>>'{public_model,provenance_sha256}'IS DISTINCT FROM p_program->>'training_provenance_checksum'THEN RAISE EXCEPTION 'numeric preparation crossbinding mismatch';END IF;
 SELECT value INTO STRICT approved FROM jsonb_array_elements(b.bundle_manifest->'public215_contexts')WHERE value->'context'=p_program->'context';
 IF p_program#>'{public_model,action_ids}'IS DISTINCT FROM approved->'model_action_order'OR p_program->>'template_checksum'IS DISTINCT FROM approved->>'template_checksum'OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.declared_coverage)x WHERE x=p_program->'context')THEN RAISE EXCEPTION 'numeric preparation differs from approved context/action order/template';END IF;
 PERFORM public.fn_gto_v31_public215_capture(d,b);source:=public.fn_gto_v31_public215_train_context(d,p_program->'context');
 IF(SELECT count(*)FROM jsonb_object_keys(source->'action_specs'))<>jsonb_array_length(p_program#>'{public_model,action_ids}')OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_program#>'{public_model,action_ids}')a WHERE NOT(source->'action_specs')?a)THEN RAISE EXCEPTION 'approved source/model action keyset differs';END IF;
 c:=jsonb_populate_record(NULL::public.gto_v31_runtime_cells,(p_program->'context')||(p_program-'context')||jsonb_build_object('dataset_id',p_dataset_id));
 IF public.fn_gto_v31_public215_provenance_valid(c,d,b,public.fn_gto_v31_public215_sources(d))IS NOT TRUE THEN RAISE EXCEPTION 'prepared program lacks complete genuine M1 source provenance';END IF;
 k:=public.fn_gto_v31_cell_key_checksum((p_program->'context')||public.fn_gto_v31_feature_identity(d.feature_contract_version)||public.fn_gto_v31_policy_identity(d.policy_export_schema));
 digest:=public.fn_gto_v31_public215_digest(jsonb_build_object('format','public_hist215_preparation_v1','program',p_program,'train_lineage_checksum',source->>'lineage_checksum'));
 sql_digest:=public.fn_gto_v31_public215_digest(jsonb_build_object('physics',public.fn_gto_v31_public215_physics_implementation(),'encoding',public.fn_gto_v31_public215_encoding_implementation()));
 INSERT INTO public.gto_v31_model_preparations(dataset_id,cell_key_checksum,context,program,identity,action_specs,train_lineage_checksum,preparation_checksum,sql_physics_checksum)VALUES(p_dataset_id,k,p_program->'context',p_program,public.fn_gto_v31_public215_program_identity(p_program),source->'action_specs',source->>'lineage_checksum',digest,sql_digest)ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_model_preparations prep WHERE prep.dataset_id=p_dataset_id AND prep.cell_key_checksum=k AND prep.program=p_program AND prep.preparation_checksum=digest AND prep.sql_physics_checksum=sql_digest)THEN RAISE EXCEPTION 'immutable numeric preparation changed';END IF;RETURN k;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_freeze_model(p_dataset_id uuid,p_freeze jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='240s' SET lock_timeout='1s' AS $fn$
DECLARE d public.gto_v31_datasets;b public.gto_v31_input_bundles;p public.gto_v31_model_preparations;c public.gto_v31_runtime_cells;k text;source jsonb;
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role'AND current_user NOT IN('postgres','supabase_admin')THEN RAISE EXCEPTION 'service_role required';END IF;
 SELECT * INTO STRICT d FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND state='building'AND policy_representation='public_hist215_v1'FOR UPDATE;SELECT * INTO STRICT b FROM public.gto_v31_input_bundles WHERE input_bundle_id=d.input_bundle_id AND approval_status='approved'AND bundle_checksum=d.input_bundle_checksum;
 IF NOT public.fn_gto_v31_public215_keys(p_freeze,ARRAY['context','model_checksum','public_model_build_receipt','model_build_receipt_checksum'])OR octet_length(public.fn_gto_v31_public215_canonical(p_freeze))>4194304 THEN RAISE EXCEPTION 'strict finite model freeze receipt required';END IF;
 SELECT * INTO STRICT p FROM public.gto_v31_model_preparations WHERE dataset_id=p_dataset_id AND context=p_freeze->'context';IF p.program->>'model_checksum'IS DISTINCT FROM p_freeze->>'model_checksum'THEN RAISE EXCEPTION 'model freeze differs from immutable numeric program';END IF;
 source:=public.fn_gto_v31_public215_train_context(d,p.context);IF source->>'lineage_checksum'IS DISTINCT FROM p.train_lineage_checksum THEN RAISE EXCEPTION 'prepared genuine M1 source lineage changed';END IF;
 c:=public.fn_gto_v31_public215_preparation_cell(p);c.public_model_build_receipt:=p_freeze->'public_model_build_receipt';c.model_build_receipt_checksum:=p_freeze->>'model_build_receipt_checksum';
 IF public.fn_gto_v31_public215_provenance_valid(c,d,b,public.fn_gto_v31_public215_sources(d))IS NOT TRUE OR public.fn_gto_v31_public215_build_receipt(c,d,b)IS NOT TRUE THEN RAISE EXCEPTION 'independent SQL/allhead parity or actual bounded Linux receipt failed';END IF;
 INSERT INTO public.gto_v31_model_freezes VALUES(p_dataset_id,p.cell_key_checksum,c.public_model_build_receipt,c.model_build_receipt_checksum,now())ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_model_freezes f WHERE f.dataset_id=p_dataset_id AND f.cell_key_checksum=p.cell_key_checksum AND f.public_model_build_receipt=c.public_model_build_receipt AND f.model_build_receipt_checksum=c.model_build_receipt_checksum)THEN RAISE EXCEPTION 'immutable model freeze receipt changed';END IF;RETURN c.model_build_receipt_checksum;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_model_preparations(p_dataset_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 1)
RETURNS TABLE(dataset_id uuid,cell_key_checksum text,context jsonb,policy_representation text,public_model jsonb,public_template jsonb,public_training_provenance jsonb,model_checksum text,template_checksum text,feature_schema_checksum text,training_provenance_checksum text,public_model_build_receipt jsonb,model_build_receipt_checksum text,preparation_checksum text,status text,runtime_parity_protocol jsonb,encoder_descriptor jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role'AND current_user NOT IN('postgres','supabase_admin')THEN RAISE EXCEPTION 'service_role required';END IF;
 RETURN QUERY SELECT p.dataset_id,p.cell_key_checksum,p.context,'public_hist215_v1'::text,p.program->'public_model',p.program->'public_template',p.program->'public_training_provenance',p.program->>'model_checksum',p.program->>'template_checksum',p.program->>'feature_schema_checksum',p.program->>'training_provenance_checksum',f.public_model_build_receipt,f.model_build_receipt_checksum,p.preparation_checksum,CASE WHEN f.cell_key_checksum IS NULL THEN 'prepared'ELSE 'frozen'END,b.bundle_manifest#>'{public215_protocols,runtime_parity_protocol}',b.bundle_manifest#>'{public215_protocols,training_recipe,encoder_descriptor}' FROM public.gto_v31_model_preparations p JOIN public.gto_v31_datasets d ON d.dataset_id=p.dataset_id AND d.state='building'JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id AND b.approval_status='approved'AND b.bundle_checksum=d.input_bundle_checksum LEFT JOIN public.gto_v31_model_freezes f ON f.dataset_id=p.dataset_id AND f.cell_key_checksum=p.cell_key_checksum WHERE p.dataset_id=p_dataset_id ORDER BY public.fn_gto_v31_public215_canonical(p.context)COLLATE "C" OFFSET greatest(COALESCE(p_offset,0),0)LIMIT 1;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_train_context(public.gto_v31_datasets,jsonb),public.fn_gto_v31_public215_preparation_cell(public.gto_v31_model_preparations),public.fn_gto_v31_prepare_model(uuid,jsonb),public.fn_gto_v31_freeze_model(uuid,jsonb),public.fn_gto_v31_model_preparations(uuid,integer,integer)FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_prepare_model(uuid,jsonb),public.fn_gto_v31_freeze_model(uuid,jsonb),public.fn_gto_v31_model_preparations(uuid,integer,integer)TO service_role;
CREATE FUNCTION public.fn_gto_v31_public215_frozen_map(d public.gto_v31_datasets)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE b public.gto_v31_input_bundles;result jsonb;capture text;count_prepared integer;count_frozen integer;authorities integer;current_source text;
BEGIN
 SELECT * INTO STRICT b FROM public.gto_v31_input_bundles WHERE input_bundle_id=d.input_bundle_id AND approval_status='approved'AND bundle_checksum=d.input_bundle_checksum;
 IF public.fn_gto_v31_public215_source_headers_valid(d)IS NOT TRUE THEN RAISE EXCEPTION 'canonical source header authority changed';END IF;
 current_source:=public.fn_gto_v31_public215_digest(jsonb_build_object('physics',public.fn_gto_v31_public215_physics_implementation(),'encoding',public.fn_gto_v31_public215_encoding_implementation()));
 SELECT p.identity->>'capture_receipt_checksum'INTO STRICT capture FROM public.gto_v31_model_preparations p WHERE p.dataset_id=d.dataset_id ORDER BY p.cell_key_checksum LIMIT 1;
 SELECT count(*),count(f.cell_key_checksum),count(DISTINCT jsonb_build_object('variant',p.identity->'variant','capture',p.identity->'capture_receipt_checksum','recipe',p.identity->'training_recipe_checksum','partition',p.identity->'source_partition_checksum','encoder',p.identity->'encoder_checksum','physics',p.identity->'physics_checksum','dependency',p.identity->'dependency_lock_checksum','protocol',p.identity->'runtime_parity_protocol_checksum'))INTO count_prepared,count_frozen,authorities FROM public.gto_v31_model_preparations p LEFT JOIN public.gto_v31_model_freezes f ON f.dataset_id=p.dataset_id AND f.cell_key_checksum=p.cell_key_checksum WHERE p.dataset_id=d.dataset_id;
 IF count_prepared<>jsonb_array_length(d.declared_coverage)OR count_frozen<>count_prepared OR authorities<>1 OR EXISTS(SELECT 1 FROM public.gto_v31_model_preparations p WHERE p.dataset_id=d.dataset_id AND(p.identity->>'capture_receipt_checksum'IS DISTINCT FROM capture OR p.sql_physics_checksum IS DISTINCT FROM current_source OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.declared_coverage)c WHERE c=p.context)))THEN RAISE EXCEPTION 'all genuine M1 numeric programs and independent bounded Linux receipts must be frozen before blind opening';END IF;
 SELECT jsonb_agg(jsonb_build_object('context',p.context,'model_checksum',p.identity->>'model_checksum','model_build_receipt_checksum',f.model_build_receipt_checksum,'template_checksum',p.identity->>'template_checksum','training_provenance_checksum',p.identity->>'training_provenance_checksum')ORDER BY public.fn_gto_v31_public215_canonical(p.context)COLLATE "C")INTO result FROM public.gto_v31_model_preparations p JOIN public.gto_v31_model_freezes f ON f.dataset_id=p.dataset_id AND f.cell_key_checksum=p.cell_key_checksum WHERE p.dataset_id=d.dataset_id;RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_frozen_map(public.gto_v31_datasets)FROM PUBLIC,anon,authenticated,service_role;
DO $preparation_bindings$
DECLARE body text;anchor text;
BEGIN
 body:=pg_get_functiondef('public.fn_gto_v31_prepare_public_physics(uuid,text,text[])'::regprocedure);
 body:=pg_temp.public215_replace(body,'DECLARE c public.gto_v31_runtime_cells%ROWTYPE;d public.gto_v31_datasets%ROWTYPE;',
 'DECLARE c public.gto_v31_runtime_cells%ROWTYPE;d public.gto_v31_datasets%ROWTYPE;p public.gto_v31_model_preparations;');
 body:=pg_temp.public215_replace(body,$anchor$ SELECT * INTO STRICT c FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND cell_key_checksum=p_cell_key_checksum AND policy_representation='public_hist215_v1';$anchor$,
 $patch$ SELECT * INTO c FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND cell_key_checksum=p_cell_key_checksum AND policy_representation='public_hist215_v1';
 IF NOT FOUND THEN
  IF d.state<>'building'THEN RAISE EXCEPTION 'private program physics preparation requires building dataset';END IF;
  SELECT * INTO STRICT p FROM public.gto_v31_model_preparations WHERE dataset_id=p_dataset_id AND cell_key_checksum=p_cell_key_checksum;c:=public.fn_gto_v31_public215_preparation_cell(p);
 END IF;$patch$);EXECUTE body;
 body:=pg_get_functiondef('public.fn_gto_v31_public215_selection_receipt(jsonb,public.gto_v31_datasets,public.gto_v31_input_bundles,text)'::regprocedure);
 anchor:=' expected:=public.fn_gto_v31_public215_selected(protocols#>''{source_partition,m2_selection}'',seed);';
 body:=pg_temp.public215_replace(body,anchor,' IF p->''frozen_models''IS DISTINCT FROM public.fn_gto_v31_public215_frozen_map(d)THEN RETURN false;END IF;'||E'\n'||anchor);EXECUTE body;
END $preparation_bindings$;
DO $representation_identity$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['gto_v31_input_bundles','gto_v31_datasets','gto_v31_runtime_cells']LOOP
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK((feature_contract_version IS DISTINCT FROM ''holdem-public-hist215-v1''AND COALESCE(policy_representation,''matrix_v2'')=''matrix_v2'')OR(feature_contract_version=''holdem-public-hist215-v1''AND policy_representation=''public_hist215_v1''AND policy_export_schema=''smarter-poker.pio-policy.v4''))',t,t||'_numeric_representation_identity_chk');
 END LOOP;
END $representation_identity$;
-- A worker must obtain server authority before opening its committed blind seed.
-- This endpoint exposes metadata only; private programs remain COMPACTOR-only.
CREATE FUNCTION public.fn_gto_v31_model_freeze_authority(p_dataset_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE d public.gto_v31_datasets;map jsonb;provenance jsonb;result jsonb;
BEGIN
 IF COALESCE(auth.role(),'')<>'service_role'AND current_user NOT IN('postgres','supabase_admin')THEN RAISE EXCEPTION 'service_role required';END IF;
 SELECT * INTO STRICT d FROM public.gto_v31_datasets WHERE dataset_id=p_dataset_id AND state='building'AND policy_representation='public_hist215_v1';map:=public.fn_gto_v31_public215_frozen_map(d);
 SELECT p.identity INTO STRICT provenance FROM public.gto_v31_model_preparations p WHERE p.dataset_id=d.dataset_id ORDER BY p.cell_key_checksum LIMIT 1;
 result:=jsonb_build_object('format','public_hist215_model_freeze_authority_v1','dataset_id',d.dataset_id,'input_bundle_checksum',d.input_bundle_checksum,'capture_receipt_checksum',provenance->>'capture_receipt_checksum','source_partition_checksum',provenance->>'source_partition_checksum','training_recipe_checksum',provenance->>'training_recipe_checksum','runtime_parity_protocol_checksum',provenance->>'runtime_parity_protocol_checksum','encoder_checksum',provenance->>'encoder_checksum','physics_checksum',provenance->>'physics_checksum','dependency_lock_checksum',provenance->>'dependency_lock_checksum','feature_schema_checksum',provenance->>'feature_schema_checksum','frozen_models',map);
 RETURN result||jsonb_build_object('authority_checksum',public.fn_gto_v31_public215_digest(result));
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_model_freeze_authority(uuid)FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_model_freeze_authority(uuid)TO service_role;
-- Bind actual complete numerical/marshalling definitions, not a caller supplied
-- implementation name. Definition hashing has no numeric model/hash cycle.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_physics_implementation()RETURNS text LANGUAGE sql STABLE SET search_path=public,extensions AS $fn$
 SELECT encode(digest(convert_to(string_agg(pg_get_functiondef(oid),E'\n'ORDER BY oid::regprocedure::text),'UTF8'),'sha256'),'hex')FROM pg_proc WHERE oid IN('public.fn_gto_v31_public215_rank(integer[])'::regprocedure,'public.fn_gto_v31_public215_dense_wtl(integer[],numeric[])'::regprocedure,'public.fn_gto_v31_public215_normalized_weights(jsonb)'::regprocedure,'public.fn_gto_v31_public215_physics_key(jsonb,text[])'::regprocedure,'public.fn_gto_v31_public215_prepare_math(jsonb,text[])'::regprocedure,'public.fn_gto_v31_public215_ratio(numeric,numeric)'::regprocedure)
$fn$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_encoding_implementation()RETURNS text LANGUAGE sql STABLE SET search_path=public,extensions AS $fn$
 SELECT encode(digest(convert_to(string_agg(pg_get_functiondef(oid),E'\n'ORDER BY oid::regprocedure::text),'UTF8'),'sha256'),'hex')FROM pg_proc WHERE oid IN('public.fn_gto_v31_public215_f64(text)'::regprocedure,'public.fn_gto_v31_public215_ratio(numeric,numeric)'::regprocedure,'public.fn_gto_v31_public215_graph(integer[],integer[])'::regprocedure,'public.fn_gto_v31_public215_base181(integer,text,jsonb)'::regprocedure,'public.fn_gto_v31_public215_features(integer,text,jsonb,numeric[])'::regprocedure,'public.fn_gto_v31_public215_compile(jsonb)'::regprocedure,'public.fn_gto_v31_public215_compiled_raw(public.gto_v31_public215_head[],double precision[])'::regprocedure,'public.fn_gto_v31_public215_action_sum(double precision[])'::regprocedure,'public.fn_gto_v31_public215_normalize(text,integer,double precision[])'::regprocedure,'public.fn_gto_v31_public215_prepare_audit(public.gto_v31_runtime_cells,text[])'::regprocedure,'public.fn_gto_v31_public215_audit_prediction(public.gto_v31_runtime_cells,text,integer)'::regprocedure,'public.fn_gto_v31_public215_required_audit(public.gto_v31_runtime_cells,text)'::regprocedure,'public.fn_gto_v31_board_relative_key_v2(integer,text)'::regprocedure)
$fn$;
-- Metadata-only freshness proof is cheap enough for the unchanged8s admission
-- boundary. Full source numerical assertions remain in original ingest/build/seal.
CREATE FUNCTION public.fn_gto_v31_public215_source_headers_valid(d public.gto_v31_datasets)
RETURNS boolean LANGUAGE sql STABLE STRICT SET search_path=public AS $fn$
 SELECT NOT EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a LEFT JOIN public.solved_spots_gold s ON s.id=a.source_row_id WHERE a.dataset_id=d.dataset_id AND(s.id IS NULL OR s.quality_status IS DISTINCT FROM 'validated'OR s.audited_at IS NULL OR s.source_artifact_checksum IS DISTINCT FROM a.source_artifact_checksum OR s.machine_id IS DISTINCT FROM a.machine_id OR s.solver_version IS DISTINCT FROM d.solver_version OR s.solver_binary_checksum IS DISTINCT FROM d.solver_binary_checksum OR s.pipeline_commit IS DISTINCT FROM d.pipeline_commit OR s.pipeline_bundle_checksum IS DISTINCT FROM d.pipeline_bundle_checksum OR s.manifest_version::text IS DISTINCT FROM d.manifest_version OR s.manifest_checksum IS DISTINCT FROM d.manifest_checksum))AND NOT EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a LEFT JOIN LATERAL(SELECT count(*)n,min(j.artifact_checksum)lo,max(j.artifact_checksum)hi,min(j.machine_id)machine FROM public.gto_v31_public_source_journal j WHERE j.dataset_id=a.dataset_id AND j.source_row_id=a.source_row_id)x ON true WHERE a.dataset_id=d.dataset_id AND(x.n<>a.node_count OR x.lo IS DISTINCT FROM a.source_artifact_checksum OR x.hi IS DISTINCT FROM a.source_artifact_checksum OR x.machine IS DISTINCT FROM a.machine_id))AND NOT EXISTS(SELECT 1 FROM public.gto_v31_public_source_journal j WHERE j.dataset_id=d.dataset_id AND NOT EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a WHERE a.dataset_id=j.dataset_id AND a.source_row_id=j.source_row_id))
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_source_headers_valid(public.gto_v31_datasets)FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_public215_sources(p_dataset public.gto_v31_datasets)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SET search_path=public AS $fn$
DECLARE result jsonb;
BEGIN
 IF public.fn_gto_v31_public215_source_headers_valid(p_dataset)IS NOT TRUE THEN RAISE EXCEPTION 'canonical approved source metadata is missing/quarantined/changed';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('source_row_id',source_row_id,'source_node',source_node,'board',board,'node_checksum',node_checksum,'artifact_checksum',artifact_checksum,'machine_id',machine_id,'context',context)ORDER BY source_row_id::text COLLATE "C",source_node COLLATE "C"),'[]')INTO result FROM public.gto_v31_public_source_journal WHERE dataset_id=p_dataset.dataset_id;RETURN result;
END $fn$;
CREATE FUNCTION public.fn_gto_v31_public215_source_geometry(p_node jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('pot',p_node#>'{line_proof,root_pot_chips}','stack',p_node#>'{line_proof,effective_stack_chips}','bb',p_node#>'{line_proof,chips_per_bb}','root_actor',CASE p_node#>>'{line_proof,hero_solver_player}'WHEN '0'THEN 'OOP'WHEN '1'THEN 'IP'ELSE NULL END,'rake',p_node#>'{complete_public_state,utility,rake}')
$fn$;
CREATE FUNCTION public.fn_gto_v31_public215_template_geometry(p_template jsonb,p_geometry jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
BEGIN
 RETURN COALESCE(p_template->>'root_actor'=p_geometry->>'root_actor'AND public.fn_gto_v31_public215_f64(p_template#>>'{scenario,pot_chips_f64}')=(p_geometry->>'pot')::double precision AND public.fn_gto_v31_public215_f64(p_template#>>'{scenario,effective_stack_chips_f64}')=(p_geometry->>'stack')::double precision AND public.fn_gto_v31_public215_f64(p_template#>>'{scenario,chips_per_bb_f64}')=(p_geometry->>'bb')::double precision AND public.fn_gto_v31_public215_f64(p_template#>>'{scenario,rake_f64,0}')=(p_geometry#>>'{rake,0}')::double precision AND public.fn_gto_v31_public215_f64(p_template#>>'{scenario,rake_f64,1}')=(p_geometry#>>'{rake,1}')::double precision,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_public215_source_geometry(jsonb),public.fn_gto_v31_public215_template_geometry(jsonb,jsonb)FROM PUBLIC,anon,authenticated,service_role;
DO $bind_geometry$
DECLARE body text;anchor text;
BEGIN
 body:=pg_get_functiondef('public.fn_gto_v31_public215_train_context(public.gto_v31_datasets,jsonb)'::regprocedure);
 body:=pg_temp.public215_replace(body,'specs jsonb;lineage text;','specs jsonb;lineage text;geometry jsonb;geometry_variants integer;');
 body:=pg_temp.public215_replace(body,'count(DISTINCT node->''action_specs''),bool_and',
 'count(DISTINCT node->''action_specs''),count(DISTINCT public.fn_gto_v31_public215_source_geometry(node)),(array_agg(public.fn_gto_v31_public215_source_geometry(node)))[1],bool_and');
 body:=pg_temp.public215_replace(body,'INTO n,variants,coherent,specs,lineage FROM nodes;',
 'INTO n,variants,geometry_variants,geometry,coherent,specs,lineage FROM nodes;');
 body:=pg_temp.public215_replace(body,'IF n<>57 OR variants<>1 OR coherent', 'IF n<>57 OR variants<>1 OR geometry_variants<>1 OR coherent');
 body:=pg_temp.public215_replace(body,'jsonb_build_object(''action_specs'',specs,''lineage_checksum'',lineage)',
 'jsonb_build_object(''action_specs'',specs,''lineage_checksum'',lineage,''root_geometry'',geometry)');EXECUTE body;
 body:=pg_get_functiondef('public.fn_gto_v31_prepare_model(uuid,jsonb)'::regprocedure);
 anchor:='source:=public.fn_gto_v31_public215_train_context(d,p_program->''context'');';
 body:=pg_temp.public215_replace(body,anchor,anchor||E'\n IF public.fn_gto_v31_public215_template_geometry(p_program->''public_template'',source->''root_geometry'')IS NOT TRUE THEN RAISE EXCEPTION ''prepared public template differs from genuine source root geometry/actor/rake'';END IF;');EXECUTE body;
 body:=pg_get_functiondef('public.fn_gto_v31_freeze_model(uuid,jsonb)'::regprocedure);
 anchor:='source:=public.fn_gto_v31_public215_train_context(d,p.context);';body:=pg_temp.public215_replace(body,anchor,anchor||E'\n IF public.fn_gto_v31_public215_template_geometry(p.program->''public_template'',source->''root_geometry'')IS NOT TRUE THEN RAISE EXCEPTION ''frozen public template differs from genuine source root geometry/actor/rake'';END IF;');EXECUTE body;
 body:=pg_get_functiondef('public.fn_gto_v31_public215_build_cell(uuid,jsonb)'::regprocedure);
 anchor:='  v_modelcell:=jsonb_populate_record(NULL::public.gto_v31_runtime_cells,v_cell||jsonb_build_object(''dataset_id'',p_dataset_id));';body:=pg_temp.public215_replace(body,anchor,anchor||E'\n  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_source_nodes)s WHERE public.fn_gto_v31_public215_template_geometry(v_modelcell.public_template,public.fn_gto_v31_public215_source_geometry(s->''node''))IS NOT TRUE)THEN RAISE EXCEPTION ''numeric template and actual M1/M2 source root geometry/actor/rake disagree'';END IF;');EXECUTE body;
END $bind_geometry$;
ALTER TABLE public.gto_v31_datasets ADD CONSTRAINT gto_v31_public215_frozen_quality_gates_chk CHECK(policy_representation IS DISTINCT FROM 'public_hist215_v1'OR quality_gates='{"max_frequency_mae":0.05,"max_sizing_mae":0.05,"max_policy_ev_mae_bb":0.05,"max_action_regret_bb":0.05,"min_regret_coverage":0.95}'::jsonb);
-- Readback is limited to actual definitions/permissions; it does not certify data.
-- @live-proof: public.fn_gto_v31_public215_physics_implementation()='66f413bc9179d5b10df7c5a73547931c47a3e90fd7895c4de596c7287e98e733' AND public.fn_gto_v31_public215_encoding_implementation()='1121d3ff6873757d8560e55f397e29df8978cc8b845259bbaa2c529f40950f6d'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_prepare_model(uuid,jsonb)'::regprocedure))='04f244517d103efb3eb532376a427eae' AND md5(pg_get_functiondef('public.fn_gto_v31_freeze_model(uuid,jsonb)'::regprocedure))='972b0c77ed9d94a7e607d1b03e8bac68' AND md5(pg_get_functiondef('public.fn_gto_v31_model_freeze_authority(uuid)'::regprocedure))='303e01fa4993ff49ab043a9dc1bd89f6'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)'::regprocedure))='de268a0908698d7a9c59f8c0b26db8f6' AND md5(pg_get_functiondef('public.fn_gto_v31_public215_frozen_map(public.gto_v31_datasets)'::regprocedure))='e3db693ea0c02f11937e908a9400d9e9' AND md5(pg_get_functiondef('public.fn_gto_v31_public215_source_headers_valid(public.gto_v31_datasets)'::regprocedure))='711af3102caad6db00a254eaa94d6ab0'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_active_cells(integer,integer)'::regprocedure))='917c8085678328fc74fe769e95c59190' AND md5(pg_get_functiondef('public.fn_gto_v31_evaluation_cells(uuid,integer,integer)'::regprocedure))='e18f71f77659e807226fe8a00fdcab03' AND md5(pg_get_functiondef('public.fn_horse_solver_agreement_v31_decision(jsonb)'::regprocedure))='d01da4ad1ce32e15c6cf4f77e16bfa3f'
-- @live-proof: has_function_privilege('service_role','public.fn_gto_v31_model_freeze_authority(uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_gto_v31_model_freeze_authority(uuid)','EXECUTE') AND NOT has_table_privilege('service_role','public.gto_v31_model_preparations','INSERT') AND NOT has_table_privilege('authenticated','public.gto_v31_public_model_audit_combos','SELECT')
COMMIT;
