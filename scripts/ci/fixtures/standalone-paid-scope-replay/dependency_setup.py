# Executed only inside the copied, private native financial fixture.
C=R/'scripts/ci/fixtures/cash-refusal-scope-time'
authority=json.loads((C/'authority.json').read_text())
for relation in authority['relations']:
    exists=q("SELECT to_regclass('public."+relation['name']+"')IS NOT NULL").stdout.strip()=='t'
    if not exists:
        columns=[x['attribute']['attname']+' '+x['type']+(' NOT NULL'if x['attribute']['attnotnull']else'')for x in relation['columns']]
        q('CREATE TABLE IF NOT EXISTS public.'+relation['name']+'('+','.join(columns)+');')
q('SET check_function_bodies=off;'+json.loads((C/'function-after.json').read_text())['definition']+';')
load(R/'scripts/ci/fixtures/weekly-cash-first-clubs/helper-after.sql')
q("CREATE TABLE IF NOT EXISTS accounting_period_recompute_requests(id uuid DEFAULT gen_random_uuid(),club_id uuid,period_start date,period_end date,status text DEFAULT 'pending',reason text,last_result jsonb DEFAULT '{}',last_requested_at timestamptz DEFAULT now(),UNIQUE(club_id,period_start,period_end));")
q("ALTER TABLE accounting_period_recompute_requests ADD COLUMN IF NOT EXISTS attempted_at timestamptz,ADD COLUMN IF NOT EXISTS requested_at timestamptz DEFAULT clock_timestamp(),ADD COLUMN IF NOT EXISTS reason text,ADD COLUMN IF NOT EXISTS attempts int DEFAULT 0;")
text=next((R/'supabase/migrations').glob('20261003232339_*')).read_text();start=text.index('CREATE FUNCTION public.fn_rakeback_recompute_split(');a=text.index('AS $f$',start)+len('AS $f$');end=text.index('$f$;',a)+len('$f$;');q('SET check_function_bodies=off;'+text[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
text=next((R/'supabase/migrations').glob('20261012181905_*')).read_text();start=text.index('CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(');tag=re.search(r'AS (\$\w*\$)',text[start:]).group(1);a=text.index(tag,start);end=text.index(tag,a+len(tag))+len(tag);q('SET check_function_bodies=off;'+text[start:end]+';')
# Before-image is loaded by the contained matrix below.
q("CREATE TABLE IF NOT EXISTS accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,certified_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(kind,union_id,period_start,period_end));CREATE TABLE IF NOT EXISTS accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,computed_at timestamptz DEFAULT clock_timestamp());")
actual={'qualification':{'function_authorities':json.loads((OWN/'captured-original-owners.json').read_text())}}
for row in actual['qualification']['function_authorities']:
    if row['metadata']['proname'] in ['fn_accounting_close_certificate','fn_accounting_close_problem','fn_accounting_close_certify']:q('SET check_function_bodies=off;'+row['definition']+';')
for row in json.loads((R/'scripts/ci/fixtures/weekly-fee-preparation/original-owners.json').read_text()):
    if row['signature']=='fn_accounting_close_windows(timestamp with time zone,timestamp with time zone)':q('SET check_function_bodies=off;'+row['definition']+';')
text=next((R/'supabase/migrations').glob('20261016123337_*')).read_text();start=text.index('CREATE OR REPLACE FUNCTION public.fn_accounting_close_proof_lifetime()');end=text.index('$function$;',start)+len('$function$;');q(text[start:end])
# Actual TQ original definition; its empty event board is a real native input,
# not a replacement ready function. Extra event relations are isolated tables.
quality_schema="""CREATE TABLE IF NOT EXISTS accounting_tournament_fee_recognitions(tournament_id uuid,recognized_at timestamptz,status text,net_rake numeric,union_id uuid,bank_club_id uuid,source_fingerprint text);
CREATE TABLE IF NOT EXISTS tournament_rake_settlements(tournament_id uuid,settled_at timestamptz,amount numeric,union_id uuid,club_id uuid);
CREATE TABLE IF NOT EXISTS tournament_terminal_settlements(tournament_id uuid,settled_at timestamptz,completed_at timestamptz);
CREATE TABLE IF NOT EXISTS tournament_cancellation_receipts(tournament_id uuid,settled_at timestamptz,fee_reversal_ids uuid[],total_rake_after numeric,fees_reversed numeric,total_rake_before numeric);
CREATE TABLE IF NOT EXISTS tournament_satellite_settlements(tournament_id uuid,settled_at timestamptz);
CREATE TABLE IF NOT EXISTS tournament_refund_entitlements(tournament_id uuid,refund_wallet_club_id uuid);
CREATE TABLE IF NOT EXISTS accounting_tournament_fee_batches(rake_record_id uuid,status text,tournament_id uuid,source_fingerprint text,rake_amount numeric);
CREATE TABLE IF NOT EXISTS accounting_tournament_recognized_sources(source_id uuid,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
CREATE TABLE IF NOT EXISTS accounting_owner_direct_fee_proofs(rake_record_id uuid);
"""
q(quality_schema)
for row in actual['qualification']['function_authorities']:
    if row['metadata']['proname']=='fn_accounting_tournament_week_quality':q('SET check_function_bodies=off;'+row['definition']+';')
text=next((R/'supabase/migrations').glob('20261019180622_*')).read_text();start=text.index('CREATE FUNCTION public.fn_accounting_owner_direct_fee_proof_valid(');end=text.index('$function$;',start)+len('$function$;');q('SET check_function_bodies=off;'+text[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
q("CREATE TABLE IF NOT EXISTS tournaments(id uuid,club_id uuid,union_id uuid);ALTER TABLE clubs ADD COLUMN IF NOT EXISTS asset text DEFAULT 'chips',ADD COLUMN IF NOT EXISTS is_platform boolean DEFAULT false;")
text=next((R/'supabase/migrations').glob('20260927155651_*')).read_text()
for name in ['fn_accounting_tournament_owner_basis_terms_at','fn_accounting_tournament_source_terms_at']:
    start=text.index('CREATE FUNCTION public.'+name+'(');end=text.index('$$;',text.index('AS $$',start)+len('AS $$'))+len('$$;');q('SET check_function_bodies=off;'+text[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
load(BASE/'preimage/fn_rake_record_is_ghost_twin.sql')

q("CREATE TABLE IF NOT EXISTS ca_launch_accounting_boundaries(scope_kind text,scope_id uuid,operation_id uuid,cutoff_at timestamptz,undone_at timestamptz);CREATE TABLE IF NOT EXISTS ca_launch_reset_operations(operation_id uuid,state text);CREATE TABLE IF NOT EXISTS ca_launch_accounting_archives(operation_id uuid,relation_name text,row_key text,before_image jsonb,row_sha256 text);")
text=next((R/'supabase/migrations').glob('20261013202353_*')).read_text();start=text.index('CREATE FUNCTION public.fn_ca_launch_rakeback_period_waived(');end=text.index('$h$;',start)+len('$h$;');q('SET check_function_bodies=off;'+text[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
