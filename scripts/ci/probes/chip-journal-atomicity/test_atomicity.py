#!/usr/bin/env python3
"""Execute real PostgreSQL bodies against isolated fixtures; never production."""
import os, subprocess, sys, re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class _SqlToken:
 kind: str
 value: str
 start: int
 end: int


@dataclass(frozen=True)
class _FunctionDefinition:
 name: str
 signature: tuple
 declaration: str
 path: str


def _sql_tokens(text):
 """Lex SQL without exposing comments, strings, or dollar-quoted text."""
 tokens=[]
 i=0
 while i<len(text):
  if text[i].isspace():
   i+=1
   continue
  if text.startswith("--",i):
   newline=text.find("\n",i+2)
   i=len(text) if newline<0 else newline+1
   continue
  if text.startswith("/*",i):
   depth=1
   end=i+2
   while end<len(text) and depth:
    if text.startswith("/*",end):
     depth+=1
     end+=2
    elif text.startswith("*/",end):
     depth-=1
     end+=2
    else:
     end+=1
   if depth:
    raise RuntimeError("Unterminated SQL block comment")
   i=end
   continue
  if text[i]=="'":
   backslash_escapes=(
    i>0 and text[i-1] in "eE"
    and (i<2 or not (text[i-2].isalnum() or text[i-2] in "_$"))
   )
   end=i+1
   while end<len(text):
    if backslash_escapes and text[end]=="\\" and end+1<len(text):
     end+=2
    elif text[end]=="'" and end+1<len(text) and text[end+1]=="'":
     end+=2
    elif text[end]=="'":
     end+=1
     break
    else:
     end+=1
   if end>len(text) or text[end-1]!="'":
    raise RuntimeError("Unterminated SQL string")
   tokens.append(_SqlToken("string",text[i:end],i,end))
   i=end
   continue
  if text[i]=='"':
   end=i+1
   while end<len(text):
    if text[end]=='"' and end+1<len(text) and text[end+1]=='"':
     end+=2
    elif text[end]=='"':
     end+=1
     break
    else:
     end+=1
   if end>len(text) or text[end-1]!='"':
    raise RuntimeError("Unterminated quoted SQL identifier")
   tokens.append(_SqlToken("identifier",text[i:end],i,end))
   i=end
   continue
  if text[i]=="$":
   delimiter=re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$",text[i:])
   if delimiter:
    marker=delimiter.group(0)
    end=text.find(marker,i+len(marker))
    if end<0:
     raise RuntimeError(f"Unterminated dollar quote {marker}")
    end+=len(marker)
    tokens.append(_SqlToken("dollar",text[i:end],i,end))
    i=end
    continue
  if text[i].isalpha() or text[i]=="_":
   end=i+1
   while end<len(text) and (text[end].isalnum() or text[end] in "_$"):
    end+=1
   tokens.append(_SqlToken("word",text[i:end],i,end))
   i=end
   continue
  tokens.append(_SqlToken("symbol",text[i],i,i+1))
  i+=1
 return tokens


def _ident(token):
 if token.kind=="word":
  return token.value.lower()
 if token.kind=="identifier":
  return token.value[1:-1].replace('""','"')
 return None


def _is_word(token,value):
 return token.kind=="word" and token.value.lower()==value


def _qualified_public_name(tokens,index):
 if index+2>=len(tokens) or _ident(tokens[index])!="public":
  return None
 if tokens[index+1].value!="." or _ident(tokens[index+2]) is None:
  return None
 return _ident(tokens[index+2]),index+2,index+3


def _matching_paren(tokens,index):
 if index>=len(tokens) or tokens[index].value!="(":
  return None
 depth=0
 for cursor in range(index,len(tokens)):
  if tokens[cursor].value=="(":
   depth+=1
  elif tokens[cursor].value==")":
   depth-=1
   if depth==0:
    return cursor
 return None


_TYPE_STARTS={
 "bigint","bigserial","bit","boolean","bool","bytea","char","character",
 "date","decimal","double","float","float4","float8","inet","int","int2",
 "int4","int8","integer","interval","json","jsonb","money","numeric","oid",
 "real","record","serial","smallint","smallserial","text","time","timestamp",
 "timestamptz","timetz","uuid","varbit","varchar","void",
}
_TYPE_ALIASES={
 "bool":"boolean","decimal":"numeric","float4":"real","float8":"double precision",
 "int":"integer","int2":"smallint","int4":"integer","int8":"bigint",
 "timestamptz":"timestamp with time zone","timetz":"time with time zone",
 "varbit":"bit varying","varchar":"character varying",
}


def _signature_argument(parts):
 """Return one PostgreSQL identity argument type, or None for OUT-only args."""
 depth=0
 trimmed=[]
 for token in parts:
  if token.value=="(":
   depth+=1
  elif token.value==")":
   depth-=1
  if depth==0 and (_is_word(token,"default") or token.value=="="):
   break
  trimmed.append(token)
 if not trimmed:
  return ""
 mode=None
 if trimmed[0].kind=="word" and trimmed[0].value.lower() in {
  "in","out","inout","variadic",
 }:
  mode=trimmed.pop(0).value.lower()
 if mode=="out":
  return None
 if len(trimmed)>1 and trimmed[0].kind in {"word","identifier"}:
  first=_ident(trimmed[0])
  second=trimmed[1].value
  if first not in _TYPE_STARTS and second not in {".","["}:
   trimmed=trimmed[1:]
 values=[]
 for token in trimmed:
  value=_ident(token) if token.kind in {"word","identifier"} else token.value
  values.append(value)
 normalized=" ".join(values)
 normalized=re.sub(r"\s*\.\s*",".",normalized)
 normalized=re.sub(r"\s*\[\s*\]","[]",normalized)
 normalized=re.sub(r"\s+"," ",normalized).strip()
 return _TYPE_ALIASES.get(normalized,normalized)


def _function_signature(tokens,open_index,close_index):
 parts=[]
 current=[]
 depth=0
 for token in tokens[open_index+1:close_index]:
  if token.value in {"(","["}:
   depth+=1
  elif token.value in {")","]",
  }:
   depth-=1
  if token.value=="," and depth==0:
   parts.append(current)
   current=[]
  else:
   current.append(token)
 if current:
  parts.append(current)
 signature=[]
 for part in parts:
  argument=_signature_argument(part)
  if argument is not None:
   signature.append(argument)
 return tuple(signature)


def _statement_tokens(text):
 """Yield outer SQL statements; semicolons in opaque tokens never split."""
 current=[]
 for token in _sql_tokens(text):
  current.append(token)
  if token.value==";":
   yield current
   current=[]
 if current:
  yield current


def _parse_create(tokens,text,path,allow_unqualified=False):
 index=0
 if not tokens or not _is_word(tokens[index],"create"):
  return None
 index+=1
 if index+1<len(tokens) and _is_word(tokens[index],"or") and _is_word(tokens[index+1],"replace"):
  index+=2
 if index>=len(tokens) or not _is_word(tokens[index],"function"):
  return None
 parsed=_qualified_public_name(tokens,index+1)
 if parsed:
  name,name_index,index=parsed
 elif (
  allow_unqualified and index+2<len(tokens)
  and _ident(tokens[index+1]) is not None and tokens[index+2].value=="("
 ):
  name=_ident(tokens[index+1])
  name_index=index+1
  index+=2
 else:
  return None
 if index>=len(tokens) or tokens[index].value!="(":
  return None
 close=_matching_paren(tokens,index)
 if close is None:
  raise RuntimeError(f"Unterminated function signature: public.{name} in {path}")
 declaration=text[tokens[0].start:tokens[-1].end]
 if not declaration.rstrip().endswith(";"):
  declaration=declaration.rstrip()+";"
 return _FunctionDefinition(
  name,_function_signature(tokens,index,close),declaration,str(path)
 ),name_index


def _parse_alter_rename(tokens,index,path):
 if index+1>=len(tokens) or not _is_word(tokens[index],"alter") or not _is_word(tokens[index+1],"function"):
  return None
 parsed=_qualified_public_name(tokens,index+2)
 if not parsed:
  return None
 source,_,cursor=parsed
 if cursor>=len(tokens) or tokens[cursor].value!="(":
  return None
 close=_matching_paren(tokens,cursor)
 if close is None:
  raise RuntimeError(f"Unterminated ALTER FUNCTION signature in {path}")
 cursor=close+1
 if cursor+2>=len(tokens) or not _is_word(tokens[cursor],"rename") or not _is_word(tokens[cursor+1],"to"):
  return None
 destination=_ident(tokens[cursor+2])
 if destination is None:
  return None
 return (source,_function_signature(tokens,parsed[2],close),destination)


def _parse_drop(tokens,path):
 if len(tokens)<2 or not _is_word(tokens[0],"drop") or not _is_word(tokens[1],"function"):
  return ()
 cursor=2
 if cursor+1<len(tokens) and _is_word(tokens[cursor],"if") and _is_word(tokens[cursor+1],"exists"):
  cursor+=2
 dropped=[]
 while cursor<len(tokens):
  parsed=_qualified_public_name(tokens,cursor)
  if not parsed:
   break
  name,_,cursor=parsed
  signature=None
  if cursor<len(tokens) and tokens[cursor].value=="(":
   close=_matching_paren(tokens,cursor)
   if close is None:
    raise RuntimeError(f"Unterminated DROP FUNCTION signature in {path}")
   signature=_function_signature(tokens,cursor,close)
   cursor=close+1
  dropped.append((name,signature))
  if cursor>=len(tokens) or tokens[cursor].value!=",":
   break
  cursor+=1
 return tuple(dropped)


def _dollar_content(token):
 marker=re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$",token.value).group(0)
 return token.value[len(marker):-len(marker)]


def _history_events(text,path):
 """Yield real migration events, including static ALTERs in DO blocks."""
 for tokens in _statement_tokens(text):
  created=_parse_create(tokens,text,path)
  if created:
   yield "create",created[0]
   continue
  for dropped in _parse_drop(tokens,path):
   yield "drop",dropped
  if tokens and _is_word(tokens[0],"alter"):
   renamed=_parse_alter_rename(tokens,0,path)
   if renamed:
    yield "rename",renamed
  if tokens and _is_word(tokens[0],"do"):
   body=next((token for token in tokens if token.kind=="dollar"),None)
   if body:
    inner=_sql_tokens(_dollar_content(body))
    for index,token in enumerate(inner):
     if _is_word(token,"alter"):
      renamed=_parse_alter_rename(inner,index,path)
      if renamed:
       yield "rename",renamed


def _renamed_definition(definition,destination):
 tokens=_sql_tokens(definition.declaration)
 parsed=_parse_create(tokens,definition.declaration,definition.path)
 if not parsed:
  raise RuntimeError(f"Could not materialize renamed function public.{destination}")
 name_token=tokens[parsed[1]]
 declaration=(
  definition.declaration[:name_token.start]+destination
  +definition.declaration[name_token.end:]
 )
 return _FunctionDefinition(
  destination,definition.signature,declaration,definition.path
 )


def _function_state(root):
 state={}
 for path in sorted((root/"supabase/migrations").glob("*.sql")):
  for event,payload in _history_events(path.read_text(),path.name):
   if event=="create":
    state[(payload.name,payload.signature)]=payload
   elif event=="drop":
    name,signature=payload
    if signature is None:
     state={key:value for key,value in state.items() if key[0]!=name}
    else:
     state.pop((name,signature),None)
   else:
    source,signature,destination=payload
    definition=state.pop((source,signature),None)
    if definition is not None:
     state[(destination,signature)]=_renamed_definition(definition,destination)
 return state


def _public_function_calls(declaration):
 """Find executable public calls without inspecting quoted dynamic SQL."""
 tokens=_sql_tokens(declaration)
 body=None
 for index,token in enumerate(tokens[:-1]):
  if _is_word(token,"as") and tokens[index+1].kind=="dollar":
   body=tokens[index+1]
   break
 if body is None:
  raise RuntimeError("Cannot inspect a function without a dollar-quoted body")
 sql=_sql_tokens(_dollar_content(body))
 calls=set()
 for index in range(len(sql)-3):
  parsed=_qualified_public_name(sql,index)
  if not parsed or parsed[2]>=len(sql) or sql[parsed[2]].value!="(":
   continue
  if index and sql[index-1].kind=="word" and sql[index-1].value.lower() in {
   "into","references",
  }:
   continue
  calls.add(parsed[0].lower())
 return calls


def _fixture_function_names(fixture):
 names=set()
 for tokens in _statement_tokens(fixture):
  created=_parse_create(tokens,fixture,"fixture.sql",allow_unqualified=True)
  if created:
   names.add(created[0].name)
 return names


def authoritative_function_closure(root, fixture, roots):
 """Resolve roots plus every public helper from ordered migration history.

 Migration ALTER FUNCTION ... RENAME TO events are part of the function graph:
 wrappers intentionally call the private name produced by the rename.  Replaying
 only the latest CREATE body loses that predecessor.  The resolver materializes
 that exact prior body under its migrated name, then walks all executable public
 calls.  Any helper absent from migrations and the explicit fixture stubs fails
 bootstrap before PostgreSQL executes a single test operation.
 """
 state=_function_state(root)
 fixture_functions=_fixture_function_names(fixture)

 def resolve(name):
  candidates=[definition for (candidate_name,_),definition in state.items() if candidate_name==name]
  if not candidates:
   return None
  if len(candidates)>1:
   signatures=", ".join("("+", ".join(item.signature)+")" for item in candidates)
   raise RuntimeError(
    f"Ambiguous public function dependency: public.{name} has live overloads: {signatures}"
   )
  return candidates[0].declaration

 ordered=[]
 complete=set()
 visiting=set()
 def visit(name,parent=None):
  name=name.lower()
  if name in fixture_functions or name in complete:
   return
  if name in visiting:
   return
  declaration=resolve(name)
  if declaration is None:
   source=f" required by public.{parent}" if parent else ""
   raise RuntimeError(f"Unresolved public function dependency: public.{name}{source}")
  visiting.add(name)
  for dependency in sorted(_public_function_calls(declaration)):
   if dependency!=name:
    visit(dependency,name)
  visiting.remove(name)
  complete.add(name)
  ordered.append((name,declaration))

 for name in sorted(roots):
  visit(name)
 return ordered


pg=os.environ.get("PSQL", "/opt/homebrew/opt/postgresql@17/bin/psql")
if os.environ.get("PGNODE"):
 args=[os.environ["PGNODE"],str(Path(__file__).resolve().parent/"postgres-runtime/query.mjs")]
elif os.environ.get("PGCONTAINER"):
 args=["docker","exec","-i",os.environ["PGCONTAINER"],"psql","-X","-q","-U","postgres","-d","journal_atomicity","-v","ON_ERROR_STOP=1"]
else:
 args=[pg,"-X","-q","-h",os.environ["PGHOST"],"-p",os.environ["PGPORT"],"-U",os.environ.get("PGUSER","smarter.poker"),"-d",os.environ.get("PGDATABASE","postgres"),"-v","ON_ERROR_STOP=1"]
def run(sql):
 r=subprocess.run(args,input=sql,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout
if "--bootstrap" in sys.argv:
 here=Path(__file__).resolve().parent
 root=here.parents[3]
 names={"fn_award_satellite_seat","atomic_distribute_rake","credit_club_rake_to_treasury","fn_ca_autoledger","fn_ca_autoledger_delete","fn_ca_post_leg","fn_club_members_ledger_writer","fn_horse_fund_from_treasury","fn_horse_seat_from_treasury","trg_entry_purchase_receipt_is_immutable"}
 fixture=here.joinpath("fixture.sql").read_text()
 definitions=authoritative_function_closure(root,fixture,names)
 receipt_trigger="""
CREATE TRIGGER z_entry_purchase_receipt_is_immutable
 BEFORE UPDATE OR DELETE ON public.entry_purchase_idempotency_receipts
 FOR EACH ROW
 EXECUTE FUNCTION public.trg_entry_purchase_receipt_is_immutable();
"""
 run(
  fixture+"\n"+"\n".join(declaration for _,declaration in definitions)
  +receipt_trigger
 )
 print(
  f"bootstrap dependency closure: {len(definitions)} authoritative functions; 0 unresolved",
  flush=True,
 )
a="'00000000-0000-4000-8000-000000000001'"
b="'00000000-0000-4000-8000-000000000002'"
c="'00000000-0000-4000-8000-000000000003'"
u="'00000000-0000-4000-8000-000000000004'"
op="'00000000-0000-4000-8000-000000000005'"
setup=f"""
INSERT INTO clubs(id) VALUES({a});
INSERT INTO bbj_pools(id,club_id) VALUES({b},{a});
INSERT INTO club_members(id,user_id,club_id) VALUES({c},{u},{a});
INSERT INTO tables(id,club_id) VALUES({b},{a});
INSERT INTO table_seats VALUES({b},{u},1,10,false,NULL);
CREATE TRIGGER auto AFTER INSERT OR UPDATE ON bbj_pools FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('main_balance=bbj_pool','backup_balance=bbj_pool','promo_balance=bbj_pool');
CREATE TRIGGER autodel BEFORE DELETE ON bbj_pools FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('main_balance=bbj_pool','backup_balance=bbj_pool','promo_balance=bbj_pool');
CREATE TRIGGER player AFTER UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();
"""
cases={
 "bbj_update":f"UPDATE bbj_pools SET main_balance=main_balance+0.25 WHERE id={b}",
 "bbj_insert":f"INSERT INTO bbj_pools(id,club_id) VALUES({c},{a})",
 "bbj_delete":f"DELETE FROM bbj_pools WHERE id={b}",
 "player_wallet":f"UPDATE club_members SET chip_balance=chip_balance-5 WHERE id={c}",
 "post_leg":f"DO $op$ BEGIN UPDATE clubs SET chip_treasury=chip_treasury+5; PERFORM fn_ca_post_leg('rake','table_stack',{b},'club_treasury',{a},5,{a},'probe:leg','test'); END $op$",
 "treasury_credit":f"SELECT credit_club_rake_to_treasury({a},5)",
 "rake_distribution":f"SELECT * FROM atomic_distribute_rake({b},{a},NULL,1,5,0,50,2,NULL,NULL,NULL,'WEIGHTED_CONTRIBUTED')",
 "seat_funding":f"SELECT fn_horse_seat_from_treasury({b},{c},2,5,{op})",
 "reload_funding":f"SELECT fn_horse_fund_from_treasury({b},{u},5,{op})",
}
state_tables=["clubs","bbj_pools","club_members","table_seats","chip_ledger","chip_transactions","cash_baselines","rake_records","rake_distribution_legs","club_wallets","club_wallet_transactions","entry_purchase_idempotency_receipts"]
state="jsonb_build_array("+",".join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {t} t)" for t in state_tables)+")"
faults=["55P03","40P01","23514","23505","XX001"]
mode=sys.argv[1]
if mode not in ("fixed","original"): raise ValueError("Expected fixed or original mode")
passed=0
for name,operation in cases.items():
 for fault in faults:
  expected="true" if mode=="fixed" else "false"
  check=f"""
DO $check$
DECLARE before_state jsonb; after_state jsonb; caught boolean:=false; st text;
BEGIN
 SELECT {state} INTO before_state;
 PERFORM set_config('test.journal_sqlstate','{fault}',true);
 BEGIN EXECUTE $statement$ {operation} $statement$;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st=RETURNED_SQLSTATE;
  IF st <> '{fault}' THEN RAISE EXCEPTION 'Unexpected SQLSTATE %: %',st,SQLERRM; END IF;
  caught:=true;
 END;
 SELECT {state} INTO after_state;
 IF caught <> {expected} THEN RAISE EXCEPTION 'Incorrect error propagation'; END IF;
 IF {expected} AND before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Partial balance/journal commit'; END IF;
 IF NOT {expected} AND before_state IS NOT DISTINCT FROM after_state THEN RAISE EXCEPTION 'Original defect not reproduced'; END IF;
END $check$;
"""
  run("BEGIN;"+setup+check+"ROLLBACK;")
  passed+=1
 print(f"{mode}: {name}: {len(faults)} fault cases passed",flush=True)
if mode=="fixed":
 expected_counts={"bbj_update":1,"bbj_insert":3,"bbj_delete":3,"player_wallet":1,"post_leg":1,"treasury_credit":1,"rake_distribution":1,"seat_funding":1,"reload_funding":1}
 success_checks={
  "bbj_update":"(SELECT main_balance FROM bbj_pools)=100.25",
  "bbj_insert":"(SELECT sum(main_balance) FROM bbj_pools)=200",
  "bbj_delete":"NOT EXISTS(SELECT 1 FROM bbj_pools)",
  "player_wallet":"(SELECT chip_balance FROM club_members)=95",
  "post_leg":"(SELECT chip_treasury FROM clubs)=105",
  "treasury_credit":"(SELECT chip_treasury FROM clubs)=105",
  "rake_distribution":"(SELECT chip_treasury FROM clubs)=105 AND (SELECT period_rake_collected FROM club_wallets)=5",
  "seat_funding":"(SELECT chip_treasury FROM clubs)=95 AND (SELECT sum(stack) FROM table_seats)=15",
  "reload_funding":"(SELECT chip_treasury FROM clubs)=95 AND (SELECT sum(stack) FROM table_seats)=15",
 }
 for name,operation in cases.items():
  run("BEGIN;"+setup+operation+";"+f"""
DO $verify$ BEGIN
 IF NOT ({success_checks[name]}) THEN RAISE EXCEPTION 'Wrong successful balances'; END IF;
 IF (SELECT count(*) FROM chip_ledger)<>{expected_counts[name]} THEN RAISE EXCEPTION 'Wrong successful journal count'; END IF;
END $verify$;ROLLBACK;""")
  passed+=1
 for name in ["rake_distribution","seat_funding","reload_funding"]:
  operation=cases[name]
  run("BEGIN;"+setup+operation+";"+f"""
DO $verify$
DECLARE first_state jsonb; replay_state jsonb;
BEGIN
 SELECT {state} INTO first_state;
 EXECUTE $operation$ {operation} $operation$;
 SELECT {state} INTO replay_state;
 IF first_state IS DISTINCT FROM replay_state THEN RAISE EXCEPTION 'Replay changed balance or journal'; END IF;
END $verify$;ROLLBACK;""")
  passed+=1
print(f"TOTAL {mode}: {passed} passing cases",flush=True)

if mode=="fixed":
 from test_horse import verify_horse
 verify_horse(run)

if mode=="fixed":
 from test_entry_purchase_helpers import verify_entry_purchase_helpers
 verify_entry_purchase_helpers(run)

if mode=="fixed":
 from test_satellite import verify_satellite
 verify_satellite(run)

if mode=="fixed":
 from test_cashout import verify_cashout
 verify_cashout(run)

if mode=="fixed":
 from test_hand import verify_hand
 if os.environ.get("HAND_ORIGINAL_PROOF"):
  verify_hand(run, os.environ["HAND_ORIGINAL_PROOF"])
 verify_hand(run)

if mode=="fixed":
 from test_union_periods import verify_union_periods
 verify_union_periods(run)

if mode=="fixed":
 from test_bbj import verify_bbj
 verify_bbj(run)
 from test_post_commit_addons import verify_post_commit_addons
 verify_post_commit_addons(run)

if mode=="fixed":
 from test_insurance import verify_insurance
 verify_insurance(run)

if mode=='fixed':
 from test_agent_context import verify_agent_context
 verify_agent_context(run)

if mode=="fixed":
 from test_tickets import verify_tickets
 verify_tickets(run)

if mode=='fixed':
 from test_rebuy_receipts import verify_rebuy_receipts
 verify_rebuy_receipts(run)

if mode=="fixed":
 from test_bbj_source_correction import verify_bbj_source_correction
 verify_bbj_source_correction(run)
