import concurrent.futures
import os
import subprocess

psql = os.environ['COMMISSION_PSQL']
def sql(query):
    result = subprocess.run([psql, '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', query], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()
def uid(n):
    return '00000000-0000-4000-8000-' + str(n).zfill(12)
def credit(player, source):
    return sql("SELECT public.credit_agent_commission_from_rake('%s','%s',100,'rake_settlement','%s');" % (uid(player),uid(900),uid(source)))

def parallel(players, source):
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda p: credit(p, source), players))
    return sql("SELECT count(*)::text || ':' || sum(amount)::text FROM agent_commissions WHERE source_id='%s';" % uid(source))

assert parallel([201,201],800) == '3:70.00'
print('PASS: concurrent same-contributor retry creates three accruals totaling 70.00 once')
assert parallel([201,202],801) == '6:140.00'
print('PASS: concurrent contributors sharing all ancestors create six accruals totaling 140.00')
credit(201,800)
assert sql("SELECT count(*) FROM agent_commissions WHERE source_id='%s';" % uid(800)) == '3'
print('PASS: later response-loss retry changes no committed rows')
