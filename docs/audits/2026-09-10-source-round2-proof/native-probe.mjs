import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { Client } = createRequire(import.meta.url)('pg');
assert.match(process.env.PGHOST || '', /^\/tmp\/ca-source-round2\.[A-Za-z0-9]+$/);
const config = { host: process.env.PGHOST, port: 55474, user: 'postgres', database: 'round2_test' };
const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
async function connect(name, role = null, actor = null) {
  const c = new Client({ ...config, application_name: name });
  await c.connect();
  if (role) await c.query('SET ROLE ' + role);
  await c.query(
    "SELECT set_config('request.jwt.claim.role',$1,false),set_config('request.jwt.claim.sub',$2,false)",
    [role || 'service_role', actor || '']
  );
  return c;
}
const started = performance.now();
const db = await connect('source_round2_main'),
  q = async (s, p = []) => (await db.query(s, p)).rows;
let seq = 1000,
  hand = 100000;
const results = [];
async function test(name, fn) {
  await fn();
  results.push({ name, pass: true });
  console.log('PASS ' + name);
}
async function setup({ treasury = 1000 } = {}) {
  let n = seq;
  seq += 1000;
  const x = {
    club: id(n),
    agent: id(n + 1),
    parent: id(n + 2),
    player: id(n + 3),
    union: id(n + 4),
  };
  await q("INSERT INTO clubs(id,name,owner_id,chip_treasury) VALUES($1,'Source fixture',$2,$3)", [
    x.club,
    id(n + 5),
    treasury,
  ]);
  await q(
    "INSERT INTO club_members(club_id,user_id,chip_balance,role) VALUES($1,$2,0,'agent'),($1,$3,0,'super_agent'),($1,$4,0,'player')",
    [x.club, x.agent, x.parent, x.player]
  );
  await q('INSERT INTO union_clubs(union_id,club_id) VALUES($1,$2)', [x.union, x.club]);
  await q(
    "INSERT INTO agents(id,user_id,club_id,role,status,commission_rate,player_rakeback_rate) VALUES($1,$1,$2,'agent','active',.50,.15)",
    [x.agent, x.club]
  );
  return x;
}
async function source(
  x,
  {
    rake = '1',
    direct = '.50',
    parent = '.70',
    settled = '2026-09-06T23:59:00Z',
    accepted = settled,
    applied = true,
    generation = 1,
    admitted = '2026-09-07T09:00:00Z',
    hashMismatch = false,
    recipient = x.agent,
    agentId = recipient,
  } = {}
) {
  const h = id(hand++);
  await q('INSERT INTO hand_atomic_commits VALUES($1,md5($1::uuid::text)||$3,$2)', [
    h,
    generation,
    hashMismatch ? 'mismatch' : '',
  ]);
  const alloc = [
    {
      agent_id: agentId,
      user_id: recipient,
      contract_rate: direct,
      downline_contract_rate: '0',
      exact_entitlement: null,
      exact_cumulative_entitlement: null,
      amount_authority: 'compatibility_projection_only',
    },
    {
      agent_id: x.parent,
      user_id: x.parent,
      contract_rate: parent,
      downline_contract_rate: direct,
      exact_entitlement: null,
      exact_cumulative_entitlement: null,
      amount_authority: 'compatibility_projection_only',
    },
  ];
  await q(
    "INSERT INTO ca_cash_commission_sources(hand_id,table_id,hand_number,requested_club_id,accepted_payload_hash,rake_total,rake_method,contributions,returned_uncalled,contributor_count,accepted_at,settled_at) VALUES($1,$2,1,$2,md5($1::uuid::text),$3,'WEIGHTED_CONTRIBUTED','{}','{}',1,$4,$5)",
    [h, x.club, rake, accepted, settled]
  );
  await q(
    "INSERT INTO ca_cash_commission_facts(hand_id,player_id,booked_club_id,payer_user_id,assignment_state,rake_credit,direct_commission_rate,player_rebate_rate,player_rebate_entitlement,player_terms,hierarchy,errors) VALUES($1,$2,$3,$4,'assigned',$5,$6,0,0,'{}','[]','[]')",
    [h, x.player, x.club, recipient, rake, direct]
  );
  const allocations = (
    await q(
      "SELECT jsonb_agg(j||jsonb_build_object('exact_entitlement',$1::numeric*((j->>'contract_rate')::numeric-(j->>'downline_contract_rate')::numeric),'exact_cumulative_entitlement',$1::numeric*(j->>'contract_rate')::numeric)) a FROM jsonb_array_elements($2::jsonb) j",
      [rake, JSON.stringify(alloc)]
    )
  )[0].a;
  if (applied)
    await q(
      "INSERT INTO ca_commission_contributor_receipts(source_type,source_id,contributing_user_id,requested_club_id,booked_club_id,rake_credit,state,allocations,created_at) VALUES('rake_settlement',$1,$2,$3,$3,$4,'applied',$5,$6)",
      [h, x.player, x.club, rake, JSON.stringify(allocations), admitted]
    );
  return h;
}
const pay = (x, recipient = x.agent, week = '2026-08-31', c = db) =>
  c
    .query('SELECT fn_pay_source_agent_week($1,$2,$3) r', [x.club, recipient, week])
    .then((r) => r.rows[0].r);
async function balance(x) {
  return (
    await q(
      'SELECT chip_treasury::text bank,(SELECT chip_balance::text FROM club_members WHERE club_id=$1 AND user_id=$2) agent,(SELECT chip_balance::text FROM club_members WHERE club_id=$1 AND user_id=$3) parent FROM clubs WHERE id=$1',
      [x.club, x.agent, x.parent]
    )
  )[0];
}
async function snapshot() {
  const tables = (
    await q(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname"
    )
  ).map((r) => r.relname);
  const out = {};
  for (const t of tables)
    out[t] = (await q('SELECT to_jsonb(t) r FROM "' + t + '" t ORDER BY to_jsonb(t)::text')).map(
      (r) => r.r
    );
  return out;
}
async function waiting(name) {
  for (let i = 0; i < 200; i++) {
    let r = (
      await q(
        "SELECT a.wait_event,pg_blocking_pids(a.pid) blockers,EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted AND l.locktype='advisory' AND l.classid=hashtext('club-arena:rakeback-payer')::oid) shared_club_admission FROM pg_stat_activity a WHERE a.application_name=$1 AND a.wait_event_type='Lock'",
        [name]
      )
    )[0];
    if (r?.blockers.length) return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('wait not observed ' + name);
}
try {
  await q("INSERT INTO ca_cash_commission_authority VALUES(true,1,'2026-09-01','before','after')");
  await test('SQL counterexamples expose per-hand lost fractions and decreasing rounded hierarchy differences', async () => {
    const r = (
      await q(
        'SELECT sum(round(.01*.25,2)) per_hand, floor(sum(.01*.25)*100)/100 exact_cash FROM generate_series(1,100)'
      )
    )[0];
    assert.equal(r.per_hand, '0.00');
    assert.equal(r.exact_cash, '0.25000000000000000000');
    const n = (
      await q(
        'SELECT round(.08*.70,2)-round(.08*.50,2) before,round(.09*.70,2)-round(.09*.50,2) after'
      )
    )[0];
    assert.equal(n.before, '0.02');
    assert.equal(n.after, '0.01');
  });
  await test('Sunday earning week survives Monday admission and captured recipient deactivation', async () => {
    const x = await setup();
    const h = await source(x);
    assert.equal(
      (
        await q(
          "SELECT s.settled_at<r.created_at AND date_trunc('day',r.created_at AT TIME ZONE 'UTC')='2026-09-07'::timestamp observed FROM ca_cash_commission_sources s JOIN ca_commission_contributor_receipts r ON r.source_id=s.hand_id WHERE s.hand_id=$1",
          [h]
        )
      )[0].observed,
      true
    );
    await q("UPDATE agents SET status='suspended' WHERE id=$1", [x.agent]);
    const r = await pay(x);
    assert.equal(r.new_payout, 0.5);
    assert.equal(r.fractional_liability, 0);
    // Current suspended status cannot erase the captured earning identity.
    assert.equal((await balance(x)).agent, '0.50');
    assert.equal((await pay(x, x.agent, '2026-09-07')).new_payout, 0);
  });
  await test('100 sequential one-cent sources carry exactly 25 cents across changing captured agent identities', async () => {
    const x = await setup();
    for (let i = 0; i < 100; i++) {
      await source(x, { rake: '.01', direct: '.25', agentId: id(800000 + i) });
      await pay(x);
    }
    assert.equal((await balance(x)).agent, '0.25');
    assert.equal((await pay(x)).new_payout, 0);
  });
  await test('late source cannot claw back an already released parent cent', async () => {
    const x = await setup();
    await source(x, { rake: '.08' });
    assert.equal((await pay(x, x.parent)).new_payout, 0.01);
    await source(x, { rake: '.01' });
    const r = await pay(x, x.parent);
    assert.equal(r.new_payout, 0);
    assert.equal(r.fractional_liability, 0.008);
    assert.equal((await balance(x)).parent, '0.01');
  });
  await test('tiny tier payouts cannot exceed exact provisional allocation', async () => {
    const x = await setup();
    await source(x, { rake: '.05', direct: '.10', parent: '.70' });
    await pay(x);
    await pay(x, x.parent);
    const r = (
      await q('SELECT sum(amount)=.03 exact_paid FROM ca_agent_source_payments WHERE club_id=$1', [
        x.club,
      ])
    )[0];
    assert.equal(r.exact_paid, true);
    assert.equal((await balance(x)).bank, '999.97');
  });
  await test('missing accrual receipt and legacy receipt generation create no new accrual or payment', async () => {
    const x = await setup();
    await source(x, { applied: false });
    await source(x, { accepted: '2026-08-31', settled: '2026-09-02', generation: null });
    const before = await snapshot();
    assert.equal((await pay(x)).new_payout, 0);
    assert.deepEqual(await snapshot(), before);
  });
  await test('synthetic earlier timestamp does not replace explicit generation1 and envelope identity', async () => {
    const x = await setup();
    await source(x, { accepted: '2026-08-31T23:59:59Z', settled: '2026-09-02T00:00:00Z' });
    assert.equal((await pay(x)).new_payout, 0.5);
  });
  await test('short treasury defers exact liabilities and synthetic treasury funding permits one payment', async () => {
    const x = await setup({ treasury: 0 });
    await source(x);
    let r = await pay(x);
    assert.equal(r.new_payout, 0);
    assert.ok(r.deferred);
    assert.equal((await balance(x)).agent, '0.00');
    await q('UPDATE clubs SET chip_treasury=1 WHERE id=$1', [x.club]);
    r = await pay(x);
    assert.equal(r.new_payout, 0.5);
    assert.equal((await pay(x)).new_payout, 0);
  });
  await test('exact claim UUID replay survives new sources and concurrent request overlap', async () => {
    const x = await setup();
    await source(x);
    const key = id(hand++),
      a = await connect('agent_claim_a', 'authenticated', x.agent),
      b = await connect('agent_claim_b', 'authenticated', x.agent);
    try {
      await a.query('BEGIN');
      const first = (
        await a.query('SELECT fn_claim_source_agent_commission($1,$2,$3) r', [x.club, x.agent, key])
      ).rows[0].r;
      const pending = b.query('SELECT fn_claim_source_agent_commission($1,$2,$3) r', [
        x.club,
        x.agent,
        key,
      ]);
      const wait = await waiting('agent_claim_b');
      assert.equal(wait.wait_event, 'advisory');
      await a.query('COMMIT');
      assert.deepEqual((await pending).rows[0].r, first);
      await source(x);
      assert.deepEqual(
        (
          await b.query('SELECT fn_claim_source_agent_commission($1,$2,$3) r', [
            x.club,
            x.agent,
            key,
          ])
        ).rows[0].r,
        first
      );
      results.push({ evidence: 'same_request_wait', wait });
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });
  await test('late source payment receipt failure rolls every public fixture row back', async () => {
    const x = await setup();
    await source(x);
    const before = await snapshot();
    await q(
      "CREATE FUNCTION source_payment_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected last source receipt failure'; END $$"
    );
    await q(
      'CREATE TRIGGER test_source_payment_failure BEFORE INSERT ON ca_agent_source_payments FOR EACH ROW EXECUTE FUNCTION source_payment_failure()'
    );
    try {
      await assert.rejects(pay(x), /injected last source receipt failure/);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await q('DROP TRIGGER test_source_payment_failure ON ca_agent_source_payments');
      await q('DROP FUNCTION source_payment_failure()');
    }
  });
  await test('direct source payer and separate claim serialize at the shared club admission lock', async () => {
    const x = await setup();
    await source(x);
    const key = id(hand++),
      a = await connect('source_claim_club_a', 'authenticated', x.agent),
      b = await connect('source_pay_club_b');
    try {
      await a.query('BEGIN');
      assert.equal(
        (
          await a.query('SELECT fn_claim_source_agent_commission($1,$2,$3) r', [
            x.club,
            x.agent,
            key,
          ])
        ).rows[0].r.amount,
        0.5
      );
      const pending = pay(x, x.agent, '2026-08-31', b),
        wait = await waiting('source_pay_club_b');
      assert.equal(wait.shared_club_admission, true);
      await a.query('COMMIT');
      assert.equal((await pending).new_payout, 0);
      assert.equal((await balance(x)).agent, '0.50');
      results.push({ evidence: 'claim_vs_payer_shared_club_wait', wait });
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });
  await test('second recipient failure rolls back the whole multi-recipient transaction', async () => {
    const x = await setup();
    await source(x);
    const before = await snapshot();
    await q(
      "CREATE FUNCTION second_recipient_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.recipient_id='" +
        x.parent +
        "'::uuid THEN RAISE EXCEPTION 'injected second recipient failure'; END IF; RETURN NEW; END $$"
    );
    await q(
      'CREATE TRIGGER test_second_recipient_failure BEFORE INSERT ON ca_agent_source_payments FOR EACH ROW EXECUTE FUNCTION second_recipient_failure()'
    );
    try {
      await q('BEGIN');
      assert.equal((await pay(x)).new_payout, 0.5);
      await assert.rejects(pay(x, x.parent), /injected second recipient failure/);
      await q('ROLLBACK');
      assert.deepEqual(await snapshot(), before);
    } finally {
      await q('ROLLBACK');
      await q('DROP TRIGGER test_second_recipient_failure ON ca_agent_source_payments');
      await q('DROP FUNCTION second_recipient_failure()');
    }
  });
  await test('accepted complete-envelope hash mismatch cannot admit an accrual', async () => {
    const x = await setup();
    await source(x, { hashMismatch: true });
    const before = await snapshot();
    assert.equal((await pay(x)).new_payout, 0);
    assert.deepEqual(await snapshot(), before);
  });
  await test('claim expected-user binding rejects account switch and immutable request scope conflicts', async () => {
    const x = await setup(),
      other = await setup();
    await source(x);
    const key = id(hand++),
      c = await connect('source_identity', 'authenticated', x.agent);
    try {
      const before = await snapshot();
      await assert.rejects(
        c.query('SELECT fn_claim_source_agent_commission($1,$2,$3)', [x.club, other.agent, key]),
        (e) => e.code === '42501' && /account_changed/.test(e.message)
      );
      assert.deepEqual(await snapshot(), before);
      await c.query('SELECT fn_claim_source_agent_commission($1,$2,$3)', [x.club, x.agent, key]);
      const paid = await snapshot();
      await assert.rejects(
        c.query('SELECT fn_claim_source_agent_commission($1,$2,$3)', [other.club, x.agent, key]),
        (e) => e.code === '23514' && /scope_conflict/.test(e.message)
      );
      assert.deepEqual(await snapshot(), paid);
      await assert.rejects(pay(x, x.parent, '2026-08-31', c), (e) => e.code === '42501');
    } finally {
      await c.end();
    }
  });
  await test('source payment keeps linked wallet and ledger evidence immutable', async () => {
    const x = await setup();
    await source(x);
    await pay(x);
    const p = (
        await q(
          'SELECT wallet_transaction_id,ledger_id FROM ca_agent_source_payments WHERE club_id=$1',
          [x.club]
        )
      )[0],
      before = await snapshot();
    for (const [table, key] of [
      ['wallet_transactions', p.wallet_transaction_id],
      ['chip_ledger', p.ledger_id],
    ]) {
      await assert.rejects(
        q('UPDATE ' + table + ' SET amount=amount+.01 WHERE id=$1', [key]),
        (e) => e.code === '55000'
      );
      await assert.rejects(
        q('DELETE FROM ' + table + ' WHERE id=$1', [key]),
        (e) => e.code === '55000'
      );
      await assert.rejects(q('TRUNCATE ' + table + ' CASCADE'), (e) => e.code === '55000');
    }
    assert.deepEqual(await snapshot(), before);
  });
  await test('last claim receipt failure rolls back allocations and every public fixture row', async () => {
    const x = await setup();
    await source(x);
    const key = id(hand++),
      c = await connect('source_request_rollback', 'authenticated', x.agent),
      before = await snapshot();
    await q(
      "CREATE FUNCTION source_request_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected last claim receipt failure'; END $$"
    );
    await q(
      'CREATE TRIGGER test_source_request_failure BEFORE INSERT ON ca_agent_source_requests FOR EACH ROW EXECUTE FUNCTION source_request_failure()'
    );
    try {
      await assert.rejects(
        c.query('SELECT fn_claim_source_agent_commission($1,$2,$3)', [x.club, x.agent, key]),
        /injected last claim receipt failure/
      );
      assert.deepEqual(await snapshot(), before);
    } finally {
      await q('DROP TRIGGER test_source_request_failure ON ca_agent_source_requests');
      await q('DROP FUNCTION source_request_failure()');
      await c.end();
    }
  });
  await test('API roles cannot mutate source accrual or cash receipt evidence', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const c = await connect('source_acl_' + role, role);
      try {
        for (const table of [
          'ca_agent_source_accruals',
          'ca_agent_source_payments',
          'ca_agent_source_requests',
        ])
          await assert.rejects(c.query('DELETE FROM ' + table), (e) => e.code === '42501');
      } finally {
        await c.end();
      }
    }
  });
  const inputs = [
    'fixture.sql',
    'money-guards.sql',
    'money-guards-coverage.json',
    'source-facts-schema-fixture.sql',
    'receipt-schema-fixture.sql',
    'union-auth-fixture.sql',
    'installed-treasury.sql',
    'installed-catalog.json',
    'source-payment-proposal.sql',
    'native-probe.mjs',
    'run-local.sh',
  ].map((file) => ({
    file,
    sha256: createHash('sha256')
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest('hex'),
  }));
  const treasury = (
    await q(
      "SELECT md5(prosrc) body_md5, md5(pg_get_functiondef(oid)) definition_md5 FROM pg_proc WHERE oid='public.fn_debit_treasury(uuid,numeric,text,jsonb)'::regprocedure"
    )
  )[0];
  assert.equal(treasury.body_md5, '8f43bf345fba1310ca8c3c40d6f8439d');
  assert.equal(treasury.definition_md5, 'eb5ad4cf85381ec4e7f88ffeb8436af3');
  writeFileSync(
    new URL('native-proof.json', import.meta.url),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        elapsed_seconds: (performance.now() - started) / 1000,
        runtime: {
          node: process.version,
          postgres: (await q('SELECT version() version'))[0].version,
        },
        installed_treasury_body_md5: treasury.body_md5,
        inputs,
        passed: results.filter((x) => x.pass).length,
        results,
        scope:
          'Source-payment prototype with captured treasury primitive and financial trigger subset; synthetic source admission; no whole production cascade, legacy claim cutover or source-final certification',
      },
      null,
      2
    ) + '\n'
  );
} finally {
  await db.end();
}
