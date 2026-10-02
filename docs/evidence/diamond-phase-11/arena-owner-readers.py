#!/usr/bin/env python3
"""Who reads the Diamond Arena's owner? A read-only inventory of production.

Diamond Phase 11 follow-up, "the arena belongs to the system"
(docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system.md). Lists every
database function, row-level-security policy, trigger and cron job that reads a
club's owner (clubs.owner_id, directly or through a helper that does), and every
client and engine file that reads clubs.owner_id. It classifies each function by
what it does with the owner.

Read-only: it runs SELECTs against the catalog through the Supabase CLI, from a
clone linked to production, and greps this repository.

    python3 docs/evidence/diamond-phase-11/arena-owner-readers.py --linked-dir ~/Documents/club-arena

Function bodies are read with comments and string literals removed, so a
mention in a comment or a message does not count. A function that builds SQL in
a string (EXECUTE) is listed separately for a human to read.
"""
import argparse, collections, json, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))

def query(linked_dir, sql):
    out = subprocess.run(['supabase', 'db', 'query', '--linked', sql, '--output', 'json'],
                         cwd=linked_dir, capture_output=True, text=True, check=True).stdout
    return json.loads(out[:out.rfind(']') + 1])

def strip(src):
    src = re.sub(r'/\*.*?\*/', ' ', src, flags=re.S)
    src = re.sub(r'--[^\n]*', ' ', src)
    return re.sub(r"'(?:[^']|'')*'", "''", src)

CALLER = r"(?:\(\s*select\s+auth\.uid\(\)\s*\)|auth\.uid\(\)|\b(?:v_uid|v_caller|v_actor|v_me|actor|v_user)\b)"
SUBJECT = (r"(?:p_user_id|p_user|p_actor|p_minted_by|p_sender|p_receiver|v_target|p_new_owner_id|u\.id|"
           r"coalesce\(p_user_id[^)]*\))")
def compares(who):
    return re.compile(r"owner_id\s*(?:=|<>|is\s+(?:not\s+)?distinct\s+from)\s*" + who + r"|" + who +
                      r"\s*(?:=|<>)\s*\w*\.?owner_id", re.I)
ADMIT, ABOUT = compares(CALLER), compares(SUBJECT)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--linked-dir', required=True)
    args = ap.parse_args()
    d = os.path.expanduser(args.linked_dir)

    fns = query(d, "select n.nspname sch, p.proname name, p.prosrc src from pg_proc p "
                   "join pg_namespace n on n.oid = p.pronamespace "
                   "where n.nspname in ('public', 'smarter_private', 'private')")
    src = collections.defaultdict(str)
    raw = collections.defaultdict(str)
    for r in fns:
        src[r['name']] += '\n' + strip(r['src'])
        raw[r['name']] += '\n' + r['src']
    names = set(src)
    reads = lambda s: bool(re.search(r'\bclubs\b', s, re.I) and re.search(r'\bowner_id\b', s, re.I))
    readers = sorted(n for n, s in src.items() if reads(s))
    dynamic = sorted(n for n, s in raw.items() if n not in readers and reads(s) and re.search(r'\bexecute\b', src[n], re.I))

    trig = query(d, "select tgname, tgfoid::regproc::text fn, pg_get_triggerdef(t.oid) def from pg_trigger t "
                    "where tgrelid = 'public.clubs'::regclass and not tgisinternal")
    trigger_readers = sorted({t['fn'].split('.')[-1] for t in trig
                              if re.search(r'\b(new|old)\.owner_id\b', src.get(t['fn'].split('.')[-1], ''), re.I)})

    groups = collections.OrderedDict((k, []) for k in (
        'admits the caller as the owner', 'asks whether a given user is the owner', 'uses the owner as a value'))
    for n in readers:
        s = src[n]
        if ADMIT.search(s):
            groups['admits the caller as the owner'].append(n)
        elif ABOUT.search(s):
            groups['asks whether a given user is the owner'].append(n)
        else:
            groups['uses the owner as a value'].append(n)

    helpers = [n for n in readers if n in (
        'is_club_admin', 'fn_club_role', 'fn_club_bank_role', 'fn_ca_is_club_control', 'fn_ca_is_club_staff',
        'fn_club_is_staff', 'fn_is_club_admin_uid', 'fn_actor_can_manage_club_treasury', 'ca_can_view_club',
        'ca_can_view_club_finances', 'fn_ca_can_review_integrity', 'fn_promo_vault_visible',
        'fn_promo_vault_can_manage', 'fn_can_manage_club_message', 'fn_ca_can_manage_agents', 'fn_ca_club_actor_role')]
    pols = query(d, "select c.relname tbl, p.polname, p.polcmd cmd, coalesce(pg_get_expr(p.polqual, p.polrelid), '') q, "
                    "coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') c from pg_policy p "
                    "join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace "
                    "where n.nspname = 'public'")
    policies = []
    for p in pols:
        e = p['q'] + ' ' + p['c']
        direct = (re.search(r'\bclubs\b', e) and 'owner_id' in e) or (p['tbl'] == 'clubs' and 'owner_id' in e)
        via = sorted({h for h in helpers if re.search(r'\b' + h + r'\s*\(', e)})
        if direct or via:
            policies.append((p['tbl'], p['polname'], p['cmd'], 'direct' if direct else 'via ' + ', '.join(via)))

    jobs = query(d, "select jobname, command from cron.job")
    callre = re.compile(r'\b([A-Za-z_][A-Za-z0-9_]*)\s*\(')
    calls = {n: {m for m in callre.findall(s) if m in names and m != n} for n, s in src.items()}
    job_hits = []
    for j in jobs:
        depth = {m: 0 for m in callre.findall(strip(j['command'])) if m in names}
        parent, queue = {}, list(depth)
        while queue:
            n = queue.pop(0)
            if depth[n] >= 4:
                continue
            for m in calls.get(n, ()):
                if m not in depth:
                    depth[m], parent[m] = depth[n] + 1, n
                    queue.append(m)
        for n in depth:
            if n in readers:
                chain = [n]
                while chain[-1] in parent:
                    chain.append(parent[chain[-1]])
                job_hits.append((j['jobname'], ' < '.join(chain)))

    files = subprocess.run(['git', 'grep', '-l', '-E', r'owner_id|ownerId', '--', 'src', 'server/src'],
                           cwd=ROOT, capture_output=True, text=True).stdout.split()
    client = []
    pattern = re.compile(r"from\('clubs'\)[^;]{0,200}owner_id|\bclub\??\.owner_id|clubData\.owner_id|owner_id === |=== \w+\.owner_id")
    for f in files:
        if re.search(r'\.test\.|__tests__|/tests/', f):
            continue
        lines = open(os.path.join(ROOT, f), encoding='utf8').read().split('\n')
        hits = [f'{i + 1}: {l.strip()[:110]}' for i, l in enumerate(lines)
                if 'owner_id' in l and ('club' in l.lower() or pattern.search(l))]
        if hits:
            client.append((f, hits[:4]))

    print(f'# Readers of a club\'s owner, production, read-only\n')
    print(f'Functions reading clubs.owner_id (comments and literals removed): {len(readers)}')
    for k, v in groups.items():
        print(f'  {k} ({len(v)}): ' + ', '.join(v))
    print(f'Functions that mention it only inside dynamic SQL text, to read by hand ({len(dynamic)}): ' + ', '.join(dynamic))
    print(f'Trigger functions on clubs that read NEW/OLD.owner_id ({len(trigger_readers)}): ' + ', '.join(trigger_readers))
    print(f'Row-level-security policies ({len(policies)}):')
    for p in sorted(policies):
        print('  ' + ' | '.join(p))
    print(f'Cron jobs that reach a reader within four calls ({len(job_hits)}):')
    for j in sorted(set(job_hits)):
        print('  ' + ' | '.join(j))
    print(f'Client and engine files that read a club\'s owner_id ({len(client)}):')
    for f, hits in sorted(client):
        print(f'  {f}')
        for h in hits:
            print(f'      {h}')

if __name__ == '__main__':
    sys.exit(main())
