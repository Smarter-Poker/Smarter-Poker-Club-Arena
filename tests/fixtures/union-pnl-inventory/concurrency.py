"""Two real PostgreSQL sessions; no mocked lock or accounting implementation."""
import json, os, pathlib, re, subprocess, sys, time
psql, socket, port = sys.argv[1:]
env = dict(os.environ, PGAPPNAME='union_inventory_native')
base = [psql, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-d', 'postgres']
def query(sql):
    return subprocess.check_output(base + ['-c', sql], text=True, env=env).strip()
def connection(name):
    return subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, bufsize=1, env=dict(env, PGAPPNAME=name))
def write(proc, sql):
    proc.stdin.write(sql + '\n'); proc.stdin.flush()
def until(proc, marker):
    lines=[]
    while True:
        line=proc.stdout.readline()
        if not line: raise AssertionError(f'connection ended before {marker}: '+proc.stderr.read())
        if line.strip()==marker: return '\n'.join(lines)
        lines.append(line)
def finish(proc):
    proc.stdin.close()
    code=proc.wait(timeout=5)
    assert code==0, proc.stderr.read()

def waiting_for_relation(name):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='"+name+"' AND wait_event_type='Lock' AND wait_event='relation';")=='1': return
        time.sleep(.02)
    raise AssertionError('expected original relation lock wait: '+name)

# Reproduce the measured installation cycle on real owner tables. No money
# moves: these no-op updates acquire the same PostgreSQL relation lock modes.
writer=connection('inventory_install_old_writer')
write(writer,"BEGIN; SELECT id FROM tables FOR SHARE; UPDATE table_seats SET stack=stack; SELECT 'seat-owned';")
until(writer,'seat-owned')
installer=connection('inventory_install_old_ddl')
write(installer,"BEGIN; SET LOCAL deadlock_timeout='50ms'; SET LOCAL lock_timeout='2s'; LOCK TABLE tables IN SHARE ROW EXCLUSIVE MODE; SELECT 'table-owned'; LOCK TABLE table_seats IN SHARE ROW EXCLUSIVE MODE; COMMIT;")
until(installer,'table-owned')
waiting_for_relation('inventory_install_old_ddl')
write(writer,'UPDATE tables SET is_private=is_private; COMMIT;')
writer.stdin.close();installer.stdin.close()
codes=[p.wait(timeout=5) for p in (writer,installer)]
errors='\n'.join(p.stderr.read() for p in (writer,installer))
assert sum(code!=0 for code in codes)==1 and 'deadlock detected' in errors,(codes,errors)
print('PASS: original tables-before-seats installation reproduces the actual owner deadlock')

root=pathlib.Path(__file__).resolve().parents[3]
migration=(root/'supabase/migrations/20260917233148_union_pnl_inventory_preserves_original_boundaries.sql').read_text()
admission=re.findall(r'^LOCK TABLE .+?;$',migration,re.M)
assert len(admission)==2 and admission[0]=='LOCK TABLE public.tables IN EXCLUSIVE MODE;'
assert admission[1].endswith(' NOWAIT;')
admission=re.findall(r'^(?:SET LOCAL lock_timeout|LOCK TABLE).+?;$',migration,re.M)
writer=connection('inventory_install_fixed_writer')
write(writer,"BEGIN; SELECT id FROM tables FOR SHARE; UPDATE table_seats SET stack=stack; SELECT 'seat-owned';")
until(writer,'seat-owned')
installer=connection('inventory_install_fixed_ddl')
write(installer,"BEGIN; SET LOCAL lock_timeout='2s'; "+' '.join(admission)+" SELECT 'admitted';")
waiting_for_relation('inventory_install_fixed_ddl')
write(writer,'UPDATE tables SET is_private=is_private; COMMIT;');finish(writer)
until(installer,'admitted')
assert int(query("SET lock_timeout='500ms'; SELECT count(*) FROM tables;"))>0
write(installer,'ROLLBACK;');finish(installer)
print('PASS: exact migration admission lets the original seat-then-table writer finish before DDL without blocking plain table reads')

# A different original owner can already hold a later source. NOWAIT must
# retire only this migration attempt and promptly release its first lock.
writer=connection('inventory_install_competing_owner')
write(writer,"BEGIN; UPDATE tournaments SET status=status; SELECT 'tournament-owned';")
until(writer,'tournament-owned')
refusal=subprocess.run(base+['-c',"BEGIN; SET LOCAL lock_timeout='2s'; "+' '.join(admission)+" ROLLBACK;"],text=True,capture_output=True,env=env,timeout=5)
assert refusal.returncode!=0 and 'could not obtain lock on relation' in refusal.stderr,refusal.stderr
write(writer,'UPDATE table_seats SET stack=stack; COMMIT;');finish(writer)
print('PASS: competing later owner refuses only installation and releases its original table lock')

# The real original trigger owns a shared transaction lock until commit.
w=connection('union_inventory_actual_writer')
write(w,"BEGIN; UPDATE public.table_seats SET stack=801 WHERE id='00000000-0000-0000-0000-000000000003'; SELECT count(*) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND mode='ShareLock' AND granted; SELECT 'writer-locked';")
assert until(w,'writer-locked').strip()=='1'
write(w,'COMMIT;'); finish(w)
print('PASS: original capture trigger retains its actual book shared lock until commit')

boundary=query('SELECT public.fn_union_week_start(now());')
book=query("SELECT public.fn_union_week_start(now())-interval '7 days';")

def run(ident, stable=False):
    rowid=f'00000000-0000-0000-0000-{ident:012d}'
    writer=connection('union_inventory_pending_writer')
    # Synthetic retained old-book receipt, inserted in a real still-open
    # transaction under the exact shared lock used by the original producer.
    write(writer, f"""BEGIN; SET TIME ZONE 'America/Chicago';
SELECT pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM '{book}'::timestamptz)::bigint::text,0));
INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,after_row)
VALUES('tables','{rowid}','{book}'::timestamptz+interval '1 day',pg_current_xact_id(),'INSERT',
jsonb_build_object('id','{rowid}','club_id',null,'union_id',null,'tournament_id',null,'is_private',true));
SELECT 'pending-ready';""")
    until(writer,'pending-ready')
    reader=connection('union_inventory_waiting_reader')
    write(reader,f"SET TIME ZONE 'Asia/Tokyo'; SELECT public.fn_union_pnl_inventory_as_of('{boundary}'::timestamptz); SELECT 'reader-done';")
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        waiting=query("SELECT count(*) FROM pg_stat_activity WHERE application_name='union_inventory_waiting_reader' AND wait_event_type='Lock' AND wait_event='advisory';")
        if waiting=='1': break
        time.sleep(.02)
    else: raise AssertionError('closed-book reader did not wait for pending original transaction')
    write(writer,'COMMIT;'); finish(writer)
    payload=json.loads(until(reader,'reader-done').strip())
    finish(reader)
    present=any(r['row']['id']==rowid for r in payload['population']['tables'])
    assert present is (not stable), ('fresh snapshot invariant violated',present,stable)
    print('PASS: '+('negative stable-reader control omits the just-committed receipt and would fail acceptance' if stable else 'closed reader waits and then sees the original committed event across different session time zones'))

run(910)
query('ALTER FUNCTION public.fn_union_pnl_inventory_as_of(timestamptz) STABLE;')
try: run(911,stable=True)
finally: query('ALTER FUNCTION public.fn_union_pnl_inventory_as_of(timestamptz) VOLATILE;')
