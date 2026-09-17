"""Source assembly only: exact historical registry slice plus captured current ACL."""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent


def acl_entries(acl):
    if not isinstance(acl, str) or not acl.startswith('{') or not acl.endswith('}'):
        raise ValueError('An explicit captured ACL array is required')
    entries = []
    for item in acl[1:-1].split(','):
        match = re.fullmatch(r'([A-Za-z_][A-Za-z_0-9]*|)=([arwdDxtm*]+)/([A-Za-z_][A-Za-z_0-9]*)', item)
        if not match:
            raise ValueError('Unrecognized captured registry ACL item')
        grantee, rights, grantor = match.groups()
        parsed_rights = re.findall(r'[arwdDxtm]\*?', rights)
        if ''.join(parsed_rights) != rights:
            raise ValueError('Malformed captured grant option')
        for right in parsed_rights:
            entries.append([grantor, grantee or 'PUBLIC', right[0], right.endswith('*')])
    if len(entries) != len({tuple(x) for x in entries}):
        raise ValueError('Duplicate captured ACL entry')
    return sorted(entries)


def main():
    capture = json.loads((HERE/'REGISTRY-CATALOG-CAPTURE.json').read_text())['rows']
    if len(capture) != 1:
        raise ValueError('One exact registry metadata row required')
    meta = capture[0]
    if meta['owner'] != 'postgres' or meta['triggers'] is not None or meta['policies'] is not None:
        raise ValueError('Unexpected registry authority; requires new review')
    source = (HERE/'registry-authoritative-slice.sql').read_text()
    values = source.split(' VALUES\n', 1)[1].split('\nON CONFLICT', 1)[0]
    token = r"(?:'(?:''|[^'])*'|NULL)"
    tuples = re.findall(r'\(\s*('+token+r')\s*,\s*('+token+r')\s*,\s*('+token+r')\s*,\s*('+token+r')\s*\)', values)
    if len(tuples) != 25:
        raise ValueError('Authoritative registry tuple extraction changed')
    decode = lambda x: None if x == 'NULL' else x[1:-1].replace("''", "'")
    rows = sorted([dict(zip(('store','treatment','counted_by','notes'), map(decode, t))) for t in tuples], key=lambda r:r['store'])
    expected = {k:v for k,v in meta.items() if k not in ('observed_at','server_version','capture_search_path','acl')}
    expected['acl_is_null'] = meta['acl'] is None
    expected['acl_entries'] = acl_entries(meta['acl'])
    (HERE/'REGISTRY-EXPECTED.json').write_text(json.dumps({'metadata':expected,'declarations':rows,'rows_epoch':'Exact25 initial migration declarations; not a current production row capture.','required_selected_stores':['issuance_reserve','club_treasury','player_wallet']},indent=2)+'\n')
    sql = """-- FUTURE PRIVATE FIXTURE ONLY. No financial helper/guard replacement.
DO $absent$ BEGIN
 IF to_regclass('public.ca_chip_store_coverage') IS NOT NULL THEN
  RAISE EXCEPTION 'Registry already exists before exact fixture overlay';
 END IF;
END $absent$;
""" + source + """
ALTER TABLE public.ca_chip_store_coverage OWNER TO postgres;
-- Remove only this new owned table's inherited defaults before exact grants.
-- NULL and empty ACL arrays are not passed to aclexplode.
DO $acl$ DECLARE v_acl aclitem[]; r record; BEGIN
 SELECT relacl INTO v_acl FROM pg_class WHERE oid='public.ca_chip_store_coverage'::regclass;
 IF v_acl IS NOT NULL AND cardinality(v_acl)>0 THEN
  FOR r IN SELECT DISTINCT x.grantee FROM aclexplode(v_acl) x LOOP
   EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.ca_chip_store_coverage FROM ' ||
     CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END;
  END LOOP;
 END IF;
END $acl$;
REVOKE ALL PRIVILEGES ON TABLE public.ca_chip_store_coverage FROM PUBLIC;
"""
    words = dict(a='INSERT',r='SELECT',w='UPDATE',d='DELETE',D='TRUNCATE',x='REFERENCES',t='TRIGGER',m='MAINTAIN')
    for grantor, grantee, right, option in expected['acl_entries']:
        if grantor != 'postgres':
            raise ValueError('Unexpected grantor requires explicit owner review')
        target = 'PUBLIC' if grantee=='PUBLIC' else '"'+grantee+'"'
        sql += 'GRANT '+words[right]+' ON TABLE public.ca_chip_store_coverage TO '+target+(' WITH GRANT OPTION' if option else '')+';\n'
    (HERE/'registry-overlay.sql').write_text(sql)


if __name__=='__main__':
    main()
