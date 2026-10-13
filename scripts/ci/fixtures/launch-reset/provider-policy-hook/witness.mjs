import { pathToFileURL } from 'node:url';
const { default: pg } = await import(pathToFileURL(process.env.QUALIFIED_PG_MODULE).href);
import assert from 'node:assert/strict';
const a = new pg.Client(),
  b = new pg.Client({ user: 'ordering_writer' }),
  o = new pg.Client();
await a.connect();
await o.connect();
await o.query('CREATE ROLE ordering_writer LOGIN');
await b.connect();
const wait = async (sql) => {
  for (let n = 0; n < 100; n++) {
    if ((await o.query(sql)).rows[0].yes) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected lock not established');
};
try {
  await o.query(
    'CREATE SCHEMA auth; CREATE TABLE auth.users(id integer); CREATE TABLE public.chip_ledger(id integer); CREATE TABLE public.invoices(id integer); ALTER TABLE public.chip_ledger OWNER TO ordering_writer; ALTER TABLE public.invoices OWNER TO ordering_writer; GRANT USAGE ON SCHEMA public,auth TO ordering_writer'
  );
  const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await a.query('BEGIN; LOCK auth.users IN ACCESS SHARE MODE');
  await b.query('BEGIN; LOCK public.chip_ledger IN ACCESS EXCLUSIVE MODE');
  const oldPolicy = b
    .query('CREATE POLICY old_policy ON public.invoices USING(true)')
    .catch((e) => e);
  await wait(
    `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='auth.users'::regclass AND mode='AccessExclusiveLock' AND NOT granted) yes`
  );
  const oldMoney = a.query('SELECT * FROM public.chip_ledger').catch((e) => e);
  const result = await oldPolicy;
  assert.equal(result.code, '40P01');
  await b.query('ROLLBACK');
  await oldMoney;
  await a.query('ROLLBACK');
  await a.query('BEGIN; LOCK auth.users IN ACCESS SHARE MODE');
  await b.query('BEGIN');
  const newPolicy = b.query('CREATE POLICY new_policy ON public.invoices USING(true)');
  await wait(
    `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='auth.users'::regclass AND mode='AccessExclusiveLock' AND NOT granted) yes`
  );
  await a.query('SELECT * FROM public.chip_ledger; COMMIT');
  await newPolicy;
  assert.equal(
    (
      await o.query(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='auth.users'::regclass AND mode='AccessExclusiveLock' AND granted) yes`
      )
    ).rows[0].yes,
    true
  );
  await b.query('LOCK public.chip_ledger IN ACCESS EXCLUSIVE MODE; COMMIT');
  console.log(
    JSON.stringify({
      qualified: true,
      old_deadlock: '40P01',
      new_order_commits: true,
      actual_old_supautils_auth_access_exclusive_proven: true,
      financial_execution: false,
    })
  );
} finally {
  await a.end();
  await b.end();
  await o.end();
}
