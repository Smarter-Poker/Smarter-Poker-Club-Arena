"""EV-only authority composition. Does not issue a certificate or seed receipts."""
from pathlib import Path
import json,re
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent

def chunks():
    # Reuse the maintained captured relation contract. No production row data,
    # scheduled jobs, outbound extensions, or unrelated triggers are installed.
    yield 'captured-relations', application_schema()
    extra=(ROOT/'tests/fixtures/cash-participant-funding/bootstrap.sql').read_text()
    yield 'cash-relations', '\n'.join(line.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ',1) for line in extra.splitlines() if line.startswith('CREATE TABLE '))
    definitions=[]
    for name in ['captured-preimages.json','captured-hand-preimages.json','captured-integration-preimages.json','captured-reader-preimages.json']:
        definitions.extend(json.loads((ROOT/'tests/fixtures/cash-participant-funding'/name).read_text()))
    sql='SET check_function_bodies=off;\n'
    for row in definitions:
        signature='public.'+row['signature']
        sql+=row['definition']+';\nREVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role;\n'
        if 'service_role=' in row['acl']:sql+='GRANT EXECUTE ON FUNCTION '+signature+' TO service_role;\n'
    yield 'original-funding-authorities',sql
    deps=json.loads((ROOT/'tests/fixtures/union-weekly-basis/captured-cash-dependencies.json').read_text())
    yield 'original-funding-dependencies','\n'.join(row['definition']+';' for row in deps)
    for version in ['20260917230925','20260917232243']:
        yield version,next((ROOT/'supabase/migrations').glob(version+'*.sql')).read_text()
    capture=json.loads((HERE/'captured-authorities.json').read_text())
    constraints=[];foreign_keys=[]
    for row in capture['relations']:
        name=row['name'] if '.' in row['name'] else 'public.'+row['name']
        def column(c):
            # Catalog-owned names and type expressions, never actor input.
            return '"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else '')
        sql='CREATE TABLE IF NOT EXISTS '+name+'('+','.join(column(c) for c in row['columns'])+');\n'
        sql+='\n'.join('ALTER TABLE '+name+' ADD COLUMN IF NOT EXISTS '+column(c)+';' for c in row['columns'])
        yield name,sql
        sql=''
        for con in row['constraints']:
            # Constraint triggers are separate authorities, never ALTER constraints.
            if con['type']=='t':continue
            statement="\nDO $ev$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='"+name+"'::regclass AND conname='"+con['name']+"') THEN ALTER TABLE "+name+' ADD CONSTRAINT "'+con['name']+'" '+con['definition']+'; END IF; END $ev$;'
            (foreign_keys if con['type']=='f' else constraints).append(statement)
        for index in row['unique_indexes']:
            sql+='\n'+index.replace('CREATE UNIQUE INDEX ','CREATE UNIQUE INDEX IF NOT EXISTS ',1)+';'
        constraints.append(sql)
    yield 'current-relation-constraints','\n'.join(constraints+foreign_keys)
    sql='SET check_function_bodies=off;\n'
    for row in capture['functions']:
        signature=row['signature'] if row['signature'].startswith('smarter_private.') else 'public.'+row['signature']
        sql+=row['definition']+';\nREVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role;\n'
        if 'service_role=' in row['acl']:sql+='GRANT EXECUTE ON FUNCTION '+signature+' TO service_role;\n'
    yield 'current-critical-authorities',sql
    trigger_names={'zzzz_stamp_table_game_scope','zzzz_stamp_table_seat_admission','zzzzz_table_parent_keys_guard','zzzzz_table_scope_cascade','trg_club_members_audit_chip_movement','trg_ca_chip_ledger_enrich','trg_chip_ledger_performed_by','trg_stamp_seat_horse_id','trg_table_seats_stamp_club','zzz_stamp_seat_occupancy','zzzz_stamp_active_seat_game_scope','zzzzz_require_live_seat_parent','zzzzz_seat_parent_keys_match'}
    triggers=json.loads((ROOT/'tests/fixtures/full-weekly-accounting/triggers-round-3.json').read_text())
    selected=[t for t in triggers if t['tgname'] in trigger_names or (t['tgname']=='trg_ca_autoledger' and t['table_name'].split('.')[-1]=='club_wallets')]
    assert trigger_names <= {t['tgname'] for t in selected}
    yield 'money-and-seat-triggers','\n'.join(t['definition'].rstrip(';')+';' for t in selected)
    yield 'service-table-access', 'GRANT USAGE ON SCHEMA public,smarter_private,extensions TO service_role; GRANT ALL ON ALL TABLES IN SCHEMA public,smarter_private TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public,smarter_private TO service_role;'



def application_schema():
    """Reuse captured application catalog without replacing native GoTrue auth."""
    source=ROOT/'tests/fixtures/full-weekly-accounting'
    q=lambda value:'"'+value.replace('"','""')+'"'
    literal=lambda value:"'"+value.replace("'","''")+"'"
    tables=[row for row in json.loads((source/'tables.json').read_text()) if row['schema_name']!='auth']
    funcs=[row for row in json.loads((source/'functions.json').read_text()) if row['schema_name']!='auth']
    out=['SET check_function_bodies=off;', 'CREATE SCHEMA IF NOT EXISTS extensions;',
         'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;',
         'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;',
         'SET search_path=public,extensions;']
    for schema in sorted({row['schema_name'] for row in funcs}-{'public','extensions'}):out.append('CREATE SCHEMA IF NOT EXISTS '+q(schema)+';')
    for typ in json.loads((source/'types.json').read_text()):
        if typ['schema_name']=='auth':continue
        assert typ['typtype']=='e'
        out.append('CREATE TYPE '+q(typ['schema_name'])+'.'+q(typ['name'])+' AS ENUM('+','.join(literal(x) for x in typ['labels'])+');')
    defaults=[];constraints=[];indexes=[];seqs=set();identities=set()
    for row in tables:
        name=q(row['schema_name'])+'.'+q(row['name']);cols=[]
        for col in row['columns']:
            line=q(col['name'])+' '+col['type']
            if col['generated']:line+=' GENERATED ALWAYS AS ('+col['default']+') STORED'
            elif col['default']:
                defaults.append('ALTER TABLE '+name+' ALTER COLUMN '+q(col['name'])+' SET DEFAULT '+col['default']+';')
                seqs.update(s if '.' in s else 'public.'+s for s in re.findall(r"nextval\('([^']+)'::regclass\)",col['default']))
            elif col['identity']:
                line+=' GENERATED BY DEFAULT AS IDENTITY'
                identities.add(row['schema_name']+'.'+row['name']+'_'+col['name']+'_seq')
            if col['notnull']:line+=' NOT NULL'
            cols.append(line)
        out.append('CREATE TABLE '+name+'('+',\n'.join(cols)+');')
        for con in row['constraints'] or []:
            if con['type']!='t':constraints.append((con['type']=='f','ALTER TABLE '+name+' ADD CONSTRAINT '+q(con['name'])+' '+con['definition']+';'))
        indexes.extend(x['definition'].rstrip(';')+';' for x in row['unique_indexes'] or [])
    for seq in sorted(seqs):out.append('CREATE SEQUENCE '+'.'.join(q(x) for x in seq.split('.'))+';')
    for seq in json.loads((source/'sequences.json').read_text()):
        name=seq['schema_name']+'.'+seq['name']
        if seq['schema_name']!='auth' and name not in seqs|identities:
            out.append('CREATE SEQUENCE '+q(seq['schema_name'])+'.'+q(seq['name'])+' AS '+seq['type']+' INCREMENT '+str(seq['seqincrement'])+' MINVALUE '+str(seq['seqmin'])+' MAXVALUE '+str(seq['seqmax'])+' START '+str(seq['seqstart'])+' CACHE '+str(seq['seqcache'])+(' CYCLE' if seq['seqcycle'] else ' NO CYCLE')+';')
    out.extend(row['definition'].rstrip(';')+';' for row in funcs)
    out+=defaults+[x[1] for x in sorted(constraints,key=lambda x:x[0])]+indexes
    # Unrelated business triggers are not a claim of complete schema parity.
    # Ledger triggers affecting the exercised money path must be installed below.
    for row in tables:
        name=q(row['schema_name'])+'.'+q(row['name'])
        if row['relrowsecurity']:out.append('ALTER TABLE '+name+' ENABLE ROW LEVEL SECURITY;')
        if row['relforcerowsecurity']:out.append('ALTER TABLE '+name+' FORCE ROW LEVEL SECURITY;')
    return '\n'.join(out)

if __name__=='__main__':
    import sys
    print(json.dumps(list(chunks())))
