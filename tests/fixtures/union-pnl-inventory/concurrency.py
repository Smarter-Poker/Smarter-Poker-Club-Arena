"""Two real PostgreSQL sessions; no mocked lock or accounting implementation."""
import json, os, subprocess, sys, time
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
