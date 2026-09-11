#!/usr/bin/env python3
"""Build local CA-03-12 option metadata from captured client payloads, without a DB connection.

This reports observed mappings and coverage gaps. Static candidates are never treated
as persisted-data proof. No source text or complete config payload is printed.
"""
import argparse, hashlib, json, re, subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

AST_SCRIPT = r"""
const fs=require('fs'); const ts=require('typescript');
const root=process.argv[1];
const inputs=[['src/lib/tournamentFromTableConfig.ts','buildTournamentConfig'],['src/services/TournamentService.ts','buildRpcConfig']];
function key(n){return n&&(ts.isIdentifier(n)||ts.isStringLiteral(n)||ts.isNumericLiteral(n))?n.text:null;}
function access(n){if(ts.isIdentifier(n))return n.text;if(ts.isPropertyAccessExpression(n)){const p=access(n.expression);return p&&p+'.'+n.name.text;}if(ts.isElementAccessExpression(n)&&n.argumentExpression&&ts.isStringLiteral(n.argumentExpression)){const p=access(n.expression);return p&&p+'.'+n.argumentExpression.text;}return null;}
function dependencies(n){const out=new Set();function walk(x){const p=(ts.isPropertyAccessExpression(x)||ts.isElementAccessExpression(x))&&access(x);if(p)out.add(p);ts.forEachChild(x,walk);}walk(n);return [...out].sort();}
const result={builders:[],display_bindings:[]};
for(const [file,wanted]of inputs){const sf=ts.createSourceFile(file,fs.readFileSync(root+'/'+file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);let matched=0;const outputs=[];function find(n){if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isVariableDeclaration(n))&&key(n.name)===wanted){matched++;function inner(x){if(ts.isPropertyAssignment(x)){const k=key(x.name);if(k)outputs.push({output_key:k,input_paths:dependencies(x.initializer)});}if(ts.isBinaryExpression(x)&&x.operatorToken.kind===ts.SyntaxKind.EqualsToken){const p=access(x.left);if(p)outputs.push({output_path:p,input_paths:dependencies(x.right)});}ts.forEachChild(x,inner);}inner(n);}else ts.forEachChild(n,find);}find(sf);result.builders.push({file,function:wanted,definitions_found:matched,assignments:outputs});}
for(const file of ['src/pages/TableConfigPage.tsx','src/components/club/CreateTournamentModal.tsx']){const sf=ts.createSourceFile(file,fs.readFileSync(root+'/'+file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);function walk(n){if(ts.isJsxAttribute(n)&&['value','checked','selected','selectedValue'].includes(key(n.name))&&n.initializer){const paths=dependencies(n.initializer);if(paths.length)result.display_bindings.push({file,attribute:key(n.name),input_paths:paths});}ts.forEachChild(n,walk);}walk(sf);}process.stdout.write(JSON.stringify(result));
"""

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def flatten(value, prefix=''):
    out={}
    if isinstance(value,dict):
        for k,v in value.items():out.update(flatten(v,f'{prefix}.{k}' if prefix else k))
    else:out[prefix]=value
    return out

def balanced(s,start):
    depth=0; quote=False; i=start
    while i<len(s):
        ch=s[i]
        if ch=="'":
            if quote and i+1<len(s) and s[i+1]=="'":i+=2;continue
            quote=not quote
        elif not quote:
            if ch=='(':depth+=1
            elif ch==')':
                depth-=1
                if depth==0:return s[start+1:i],i+1
        i+=1
    raise ValueError('Unbalanced SQL parentheses')

def split_sql(s):
    out=[]; depth=0; quote=False; start=0; i=0
    while i<len(s):
        ch=s[i]
        if ch=="'":
            if quote and i+1<len(s) and s[i+1]=="'":i+=2;continue
            quote=not quote
        elif not quote:
            if ch=='(':depth+=1
            elif ch==')':depth-=1
            elif ch==',' and depth==0:out.append(s[start:i].strip());start=i+1
        i+=1
    out.append(s[start:].strip());return out

def creator_metadata(root):
    files=[root/p for p in ['supabase/migrations/20260901130000_game_and_ticker_management.sql','supabase/migrations/20260902014858_payout_percent_reaches_the_row_from_the_create_form.sql','supabase/migrations/20260903172703_an_event_may_restart_every_week.sql']]
    definitions=[]
    pat=re.compile(r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:public\.)?[a-z_][a-z_0-9]*)\s*\(.*?\bAS\s+(\$[A-Za-z_0-9]*\$)(.*?)\2',re.I|re.S)
    for p in files:
        for m in pat.finditer(p.read_text()):
            if re.search(r'INSERT\s+INTO\s+(?:public\.)?tournaments\s*\(',m.group(3),re.I):definitions.append((p,m.group(3),m.group(1)))
    if not definitions:return {'definitions_found':0,'column_candidates':[],'warning':'No complete tournament inserting creator definition parsed'},files
    p,body,original_function=definitions[-1]; mappings=[]; unparsed=0
    for m in re.finditer(r'INSERT\s+INTO\s+(?:public\.)?tournaments\s*\(',body,re.I):
        cols,end=balanced(body,m.end()-1);v=re.match(r'\s*VALUES\s*\(',body[end:],re.I)
        if not v:unparsed+=1;continue
        vals,_=balanced(body,end+v.end()-1)
        cs,vs=split_sql(cols),split_sql(vals)
        if len(cs)!=len(vs):raise ValueError('Governed creator column/value arity mismatch')
        for col,expr in zip(cs,vs):
            keys=sorted(set(re.findall(r"(?:p_config|v_config)\s*->>?\s*'([^']+)'",expr)))
            mappings.append({'column':col.strip(' \"'),'rpc_config_keys':keys,'derivation':'config_lookup' if keys else 'derived_or_fixed','casts':sorted(set(re.findall(r'::\s*([a-z_][a-z_0-9]*)',expr,re.I)))})
    return {'definitions_found':len(definitions),'selected_source':str(p.relative_to(root)),'original_function_name':original_function,'later_patch_sources_require_confirmation':True,'column_candidates':mappings,'unparsed_insert_count':unparsed,'all_config_keys_read':sorted(set(re.findall(r"(?:p_config|v_config)\s*->>?\s*'([^']+)'",body))),'delegated_function_names':sorted(set(re.findall(r'public\.(fn_[a-z0-9_]+)\s*\(',body)))},files

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[3]);ap.add_argument('--captures',type=Path,default=Path('/tmp/codex-phase-three-create-client-configs.json'));ap.add_argument('--output',type=Path);args=ap.parse_args();root=args.root.resolve()
    output=args.output or root/'docs/audits/2026-09-11-tournament-create-options-matrix.json'
    rows=json.loads(args.captures.read_text())
    if not isinstance(rows,list) or not rows or any(set(r)!={'input','mapped','rpc'} for r in rows):raise ValueError('Expected nonempty input/mapped/rpc capture list')
    ast_data=json.loads(subprocess.check_output(['/opt/homebrew/bin/node','-e',AST_SCRIPT,str(root)],cwd=root,text=True))
    sql,sql_files=creator_metadata(root)
    flat=[{k:flatten(r[k]) for k in ['input','mapped','rpc']} for r in rows]
    paths={section:sorted({k for r in flat for k in r[section]}) for section in ['input','mapped','rpc']}
    coverage={}
    for section in paths:
        coverage[section]=[{ 'path':k,'present_count':sum(k in r[section] for r in flat),'distinct_value_count':len({json.dumps(r[section][k],sort_keys=True) for r in flat if k in r[section]}),'captured_case_indexes':[i for i,r in enumerate(flat) if k in r[section]]} for k in paths[section]]
    unique={};case_indexes=[]
    for i,r in enumerate(rows):
        h=hashlib.sha256(json.dumps(r['rpc'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        unique.setdefault(h,[]).append(i)
    for h,indexes in unique.items():case_indexes.append({'rpc_sha256':h,'representative_capture_index':indexes[0],'duplicate_capture_indexes':indexes[1:]})
    columns={}
    for x in sql.get('column_candidates',[]):
        for k in x['rpc_config_keys']:columns.setdefault(k,[]).append(x['column'])
    rpc_roots=sorted({k.split('.')[0] for k in paths['rpc']})
    matrix=[{'rpc_root_key':k,'candidate_database_columns':sorted(set(columns.get(k,[]))),'read_elsewhere_in_creator':k in sql.get('all_config_keys_read',[]),'capture_path_coverage':[x for x in coverage['rpc'] if x['path']==k or x['path'].startswith(k+'.')],'persisted_native_verified_by_this_report':False} for k in rpc_roots]
    source_paths=[root/x['file'] for x in ast_data['builders']]+[root/'src/pages/TableConfigPage.tsx',root/'src/components/club/CreateTournamentModal.tsx']+sql_files
    report={'generated_at':datetime.now(timezone.utc).isoformat(),'kind':'static_and_captured_option_metadata','native_execution':False,'capture_source_path':str(args.captures),'capture_sha256':digest(args.captures),'captured_case_count':len(rows),'unique_rpc_count':len(unique),'duplicate_count':len(rows)-len(unique),'source_sha256':{str(p.relative_to(root)):digest(p) for p in source_paths},'builder_and_display_metadata':ast_data,'creator_metadata':sql,'captured_path_coverage':coverage,'rpc_to_database_matrix':matrix,'representative_cases':case_indexes,'limitations':['No database or browser execution. Static candidate mappings are not proof of persistence.','Zero or one observed value does not prove an option works for all allowed values.','A missing direct creator read is a review candidate, not a defect: delegated functions and normalization may handle it.','Captured unit-test calls do not record expected acceptance/refusal labels; do not assume all 58 distinct payloads are valid event creations.','Display bindings span full shared pages, including cash-only controls; variant visibility needs source-local classification.','Visible controls with compound expressions or spread properties require source-local review; this parser records static property dependencies only.','The selected tracked creator definition must be confirmed against the current deployed function before claiming current-server coverage.']}
    report['evidence_fingerprint']=hashlib.sha256(json.dumps({k:v for k,v in report.items() if k!='generated_at'},sort_keys=True,separators=(',',':')).encode()).hexdigest()
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n')
    md=output.with_suffix('.md')
    lines=['# Tournament Create Options Matrix','',f'Captured client calls: {len(rows)}. Distinct RPC payloads: {len(unique)}. Duplicate captures: {len(rows)-len(unique)}.','', 'This is a reproducible option-coverage map. It does not claim native persistence or browser acceptance.','', '| RPC Option | Candidate Database Columns | Distinct Captured Values |','| --- | --- | --- |']
    for x in matrix:
        counts=', '.join(f"{c['path']}: {c['distinct_value_count']}" for c in x['capture_path_coverage'])
        lines.append('| '+x['rpc_root_key']+' | '+(', '.join(x['candidate_database_columns']) or 'Requires source-local review')+' | '+counts+' |')
    lines+=['','## Native Extension Assertions','','1. Reuse the existing authenticated create fixture and caller session. Classify each representative payload against its original test expectation before native use; captures include helper calls and do not record acceptance/refusal labels. Original duplicate client calls do not add native coverage.','2. Confirm the current creator hash matches the selected tracked definition. For each option, compare the actual row or nested configuration with the captured RPC value after documented server normalization.','3. Check every nondefault captured value, nested configuration, enum, and boundary represented by the original client tests. Treat single-value options as unvaried coverage.','4. Compare MTT, SNG, and Spin rows separately and confirm unsupported settings are refused or explicitly normalized. Do not infer success from an unused JSON key.','5. Preserve the root create/edit permission and immutable-money probes. This option extension should not repeat funded entry, payout, or final-deal proofs.','6. Execute under one outer rollback and require exact business-table/catalog restoration.','', '## Limits','']+['- '+x for x in report['limitations']]
    md.write_text('\n'.join(lines)+'\n')
    print(json.dumps({'status':'metadata_written','captured_cases':len(rows),'unique_rpc_payloads':len(unique),'builder_definitions_found':sum(x['definitions_found'] for x in ast_data['builders']),'governed_creator_definitions_found':sql['definitions_found'],'column_candidate_count':len(sql['column_candidates']),'unparsed_insert_count':sql.get('unparsed_insert_count',0),'matrix_sha256':digest(output),'native_execution':False}))
if __name__=='__main__':main()
