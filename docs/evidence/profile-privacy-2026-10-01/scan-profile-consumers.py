import os, re, sys, json
ROOT = sys.argv[1]
DIRS = sys.argv[2].split(',')
PRIV = ['diamonds','diamond_balance','diamond_multiplier','first_name','last_name','full_name','birth_year','city','state','country','last_seen','last_login','last_login_date','last_active','referred_by','poker_near_me_preferences','updated_at']
EXTS = ('.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.rs','.swift','.kt','.dart','.vue','.svelte')
files = []
for d in DIRS:
    p = os.path.join(ROOT, d)
    for dp, dn, fn in os.walk(p):
        dn[:] = [x for x in dn if x not in ('node_modules','.git','dist','build','.next','coverage','.agent-trees','__snapshots__')]
        for f in fn:
            if f.endswith(EXTS): files.append(os.path.join(dp, f))
# constants: export const NAME = '...' or `...`
consts = {}
cre = re.compile(r"(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*(['\"`])((?:\\.|(?!\2).)*?)\2", re.S)
src = {}
for f in files:
    try: s = open(f, encoding='utf-8', errors='ignore').read()
    except Exception: continue
    src[f] = s
    for m in cre.finditer(s):
        consts.setdefault(m.group(1), m.group(3))
def resolve(t, depth=0):
    if depth > 5: return t
    def rep(m):
        k = m.group(1)
        return resolve(consts[k], depth+1) if k in consts else '${'+k+'}'
    return re.sub(r"\$\{\s*([A-Z_][A-Z0-9_]*)\s*\}", rep, t)
def privhits(t):
    return [c for c in PRIV if re.search(r'(?<![a-z_])'+c+r'(?![a-z_])', t)]
out = []
fromre = re.compile(r"\.from\(\s*(['\"`])profiles\1\s*\)")
for f, s in src.items():
    rel = os.path.relpath(f, ROOT)
    istest = bool(re.search(r'(\.test\.|\.spec\.|/tests?/|__tests__|/e2e)', rel))
    for m in fromre.finditer(s):
        line = s.count('\n', 0, m.start()) + 1
        tail = s[m.end(): m.end()+1500]
        nx = re.search(r"\.from\(|\n\s*\n", tail)
        chain = tail[: nx.start()] if nx else tail
        # stop at first ';' at depth 0-ish
        semi = chain.find(';')
        if semi >= 0: chain = chain[:semi]
        sel = re.search(r"\.select\(\s*(['\"`])((?:\\.|(?!\1).)*?)\1", chain, re.S)
        selarg = resolve(sel.group(2)) if sel else ('<select(var)>' if '.select(' in chain else '<no select>')
        ops = re.findall(r"\.(select|update|upsert|insert|delete|eq|neq|in|order|or|ilike|like|gte|lte|gt|lt|is|not|filter|match|textSearch|contains|range|limit|single|maybeSingle)\(", chain)
        filt = re.findall(r"\.(?:eq|neq|in|order|ilike|like|gte|lte|gt|lt|is|not|filter|match|textSearch|contains)\(\s*(['\"`])([a-z_0-9.]+)\1", chain)
        orr = re.findall(r"\.or\(\s*(['\"`])((?:\\.|(?!\1).)*?)\1", chain, re.S)
        flags = set(privhits(selarg))
        for _, col in filt:
            flags |= set(privhits(col))
        for _, o in orr:
            flags |= set(privhits(o))
        star = '*' in selarg.replace('count', '')
        out.append(dict(file=rel, line=line, test=istest, ops=','.join(dict.fromkeys(ops)), select=re.sub(r'\s+',' ',selarg)[:300], filters=[c for _,c in filt], ors=[re.sub(r'\s+',' ',o)[:120] for _,o in orr], flags=sorted(flags), star=star))
# embedded profiles in other selects
emb = []
for f, s in src.items():
    rel = os.path.relpath(f, ROOT)
    istest = bool(re.search(r'(\.test\.|\.spec\.|/tests?/|__tests__|/e2e)', rel))
    for im in re.finditer(r"(?<![\w.])(?:\w+:)?profiles(?:!\w+)?\s*\(([^()]{0,600})\)", s):
        if s[max(0,im.start()-6):im.start()].endswith('from'): continue
        inner = resolve(im.group(1))
        if inner.strip().startswith(("'", '"', '`')): continue
        line = s.count('\n', 0, im.start()) + 1
        emb.append(dict(file=rel, line=line, test=istest, inner=re.sub(r'\s+',' ',inner)[:300], flags=privhits(inner), star=('*' in inner)))
json.dump(dict(direct=out, embedded=emb), open(sys.argv[3], 'w'), indent=1)
print('files', len(files), 'direct', len(out), 'embedded', len(emb))
