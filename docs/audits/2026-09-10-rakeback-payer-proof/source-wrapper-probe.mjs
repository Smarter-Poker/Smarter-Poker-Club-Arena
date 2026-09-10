import assert from 'node:assert/strict';
export async function runWrapperTests({
  q,
  db,
  fullSnapshot,
  setup,
  source,
  snapshot,
  pay,
  connect,
  observedWait,
  id,
  test,
  results,
}) {
  let request = 900000;
  const claim = async (c, club = null, req = id(request++)) =>
    (await c.query('SELECT fn_claim_captured_rakeback($1,auth.uid(),$2) result', [req, club]))
      .rows[0].result;
  const actor = async (name, uid) => {
    const c = await connect(name, 'authenticated');
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
    return c;
  };
  await test('claim discovers canonical source weeks and read model subtracts immutable cash receipts', async () => {
    const x = await setup();
    await source(x);
    await source(x, { settled: '2026-08-25', accepted: '2026-08-25' });
    const c = await actor('claim_discovery', x.user);
    try {
      const read = async () => (await c.query('SELECT fn_get_captured_rakeback() r')).rows[0].r;
      const before = await read();
      assert.equal(
        before.periods.reduce((n, p) => n + p.pending_amount, 0),
        30
      );
      const r = await claim(c, x.club);
      assert.equal(r.total_payout, 30);
      assert.equal(r.periods_claimed, 2);
      const after = await read();
      assert.equal(
        after.periods.reduce((n, p) => n + p.pending_amount, 0),
        0
      );
      assert.equal(
        after.periods.reduce((n, p) => n + p.paid_amount, 0),
        30
      );
      assert.equal(
        after.periods.every((p) => p.status === 'settled_so_far'),
        true
      );
      assert.equal((await snapshot(x)).period_status, 'pending');
    } finally {
      await c.end();
    }
  });
  await test('exact claim request replay returns original result despite later sources and changed scope refuses', async () => {
    const x = await setup();
    await source(x);
    const req = id(request++);
    const c = await actor('claim_replay', x.user),
      stranger = await actor('claim_stranger', id(999999));
    try {
      const first = await claim(c, x.club, req);
      await source(x, { rake: '20' });
      assert.deepEqual(await claim(c, x.club, req), first);
      await assert.rejects(claim(c, null, req), (e) => e.code === '23514');
      await assert.rejects(claim(stranger, x.club, req), (e) => e.code === '23514');
      const next = await claim(c, x.club);
      assert.equal(next.total_payout, 3);
      assert.equal((await snapshot(x)).player, '18.00');
    } finally {
      await Promise.all([c.end(), stranger.end()]);
    }
  });
  await test('legacy browser mutation retires at cutover while source claim and close share one receipt', async () => {
    const x = await setup();
    await source(x);
    const c = await actor('legacy_claim', x.user);
    try {
      await assert.rejects(
        c.query('SELECT fn_claim_rakeback($1)', [x.club]),
        (e) => e.code === '55000'
      );
      const first = await claim(c, x.club);
      assert.equal(first.total_payout, 15);
      const second = (await db.query('SELECT fn_close_settlement_period($1) r', [x.period])).rows[0]
        .r;
      assert.equal(second.payout, 0);
      assert.equal((await snapshot(x)).payments, 1);
    } finally {
      await c.end();
    }
  });
  await test('observed claim versus batch lock overlap pays only the captured source once', async () => {
    const x = await setup();
    await source(x);
    const block = await connect('wrapper_block', null),
      a = await actor('wrapper_claim', x.user),
      b = await connect('wrapper_batch');
    try {
      await block.query('BEGIN');
      await block.query('SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 FOR UPDATE', [
        x.club,
        x.payer,
      ]);
      const first = claim(a, x.club);
      const waitA = await observedWait('wrapper_claim');
      const second = b.query('SELECT fn_settle_club_rakeback_batch($1,40,30,0) r', [x.club]);
      const waitB = await observedWait('wrapper_batch');
      assert.equal(waitB.wait_event, 'advisory');
      await block.query('COMMIT');
      const [ra, rb] = await Promise.all([first, second]);
      assert.equal(ra.total_payout + rb.rows[0].r.total_payout, 15);
      assert.equal((await snapshot(x)).payments, 1);
      results.push({ evidence: 'claim_batch_observed_overlap', waitA, waitB });
    } finally {
      await Promise.all([block.end(), a.end(), b.end()]);
    }
  });
  await test('captured production union overseer authorizes nested source payer and rejects unrelated actor', async () => {
    const x = await setup();
    await source(x);
    const union = id(request++),
      owner = id(request++);
    await q('INSERT INTO unions(id,owner_id) VALUES($1,$2)', [union, owner]);
    await q('INSERT INTO union_clubs(union_id,club_id) VALUES($1,$2)', [union, x.club]);
    const c = await actor('union_owner', owner),
      bad = await actor('union_outsider', id(request++));
    const round = (actor) =>
      actor.query(
        "SELECT fn_settle_round3_agents_to_players($1,'2026-08-31T00:00:00Z','2026-09-07T00:00:00Z') r",
        [union]
      );
    try {
      await assert.rejects(round(bad), (e) => e.code === '42501');
      const r = (await round(c)).rows[0].r;
      assert.equal(r.amount, 15);
      assert.equal(r.source_final, false);
      assert.equal((await round(c)).rows[0].r.amount, 0);
      assert.equal((await snapshot(x)).treasury, '1000.00');
    } finally {
      await Promise.all([c.end(), bad.end()]);
    }
  });
  await test('union full-week selection never expands a partial window into another entitlement', async () => {
    const x = await setup();
    await source(x);
    const union = id(request++);
    await q('INSERT INTO union_clubs(union_id,club_id) VALUES($1,$2)', [union, x.club]);
    const r = (
      await q(
        "SELECT fn_settle_round3_agents_to_players($1,'2026-09-01T00:00:00Z','2026-09-07T00:00:00Z') r",
        [union]
      )
    )[0].r;
    assert.equal(r.amount, 0);
    assert.equal((await snapshot(x)).payments, 0);
  });
  await test('claim receipt failure rolls all payments and discovery back together', async () => {
    const x = await setup();
    await source(x);
    await source(x, { settled: '2026-08-25', accepted: '2026-08-25' });
    const before = await fullSnapshot(),
      c = await actor('claim_receipt_failure', x.user);
    await q(
      "CREATE FUNCTION fail_claim_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected claim receipt failure'; END $$"
    );
    await q(
      'CREATE TRIGGER test_fail_claim_receipt BEFORE INSERT ON ca_rakeback_claim_requests FOR EACH ROW EXECUTE FUNCTION fail_claim_receipt_test()'
    );
    try {
      await assert.rejects(claim(c, x.club), /injected claim receipt failure/);
      assert.deepEqual(await fullSnapshot(), before);
    } finally {
      await q('DROP TRIGGER test_fail_claim_receipt ON ca_rakeback_claim_requests');
      await q('DROP FUNCTION fail_claim_receipt_test()');
      await c.end();
    }
  });
  await test('claim receipts reject even owner rewrites and API direct mutation', async () => {
    for (const sql of [
      'UPDATE ca_rakeback_claim_requests SET created_at=created_at',
      'DELETE FROM ca_rakeback_claim_requests',
      'TRUNCATE ca_rakeback_claim_requests',
    ])
      await assert.rejects(q(sql), (e) => e.code === '55000');
    const c = await connect('claim_receipt_acl');
    try {
      await assert.rejects(
        c.query('DELETE FROM ca_rakeback_claim_requests'),
        (e) => e.code === '42501'
      );
    } finally {
      await c.end();
    }
  });

  await test('batch attempt ordering skips settled weeks and does not starve a funded player behind a short payer', async () => {
    const x = await setup({ balance: 10 });
    await source(x);
    const y = { ...x, user: id(request++), period: id(request++), payer: x.second };
    await q('UPDATE club_members SET chip_balance=100 WHERE club_id=$1 AND user_id=$2', [
      x.club,
      x.second,
    ]);
    await q(
      "INSERT INTO club_members(club_id,user_id,chip_balance,role,agent_id) VALUES($1,$2,0,'player',$3)",
      [y.club, y.user, y.payer]
    );
    await source(y);
    const batch = async () =>
      (await q('SELECT fn_settle_club_rakeback_batch($1,1,30,0) r', [x.club]))[0].r;
    assert.equal((await batch()).total_payout, 0);
    assert.equal((await batch()).total_payout, 15);
    assert.equal((await batch()).total_payout, 0);
    await q('UPDATE club_members SET chip_balance=20 WHERE club_id=$1 AND user_id=$2', [
      x.club,
      x.payer,
    ]);
    assert.equal((await batch()).total_payout, 15);
    assert.equal(
      (await q('SELECT * FROM fn_captured_rakeback_due_periods($1)', [x.club])).length,
      0
    );
    assert.equal(
      (
        await q('SELECT count(*)::int n FROM ca_rakeback_source_payments WHERE club_id=$1', [
          x.club,
        ])
      )[0].n,
      2
    );
  });
  await test('observed authenticated Round 3 versus close shares source payment identity', async () => {
    const x = await setup();
    await source(x);
    const union = id(request++),
      owner = id(request++);
    await q('INSERT INTO unions(id,owner_id) VALUES($1,$2)', [union, owner]);
    await q('INSERT INTO union_clubs(union_id,club_id) VALUES($1,$2)', [union, x.club]);
    const block = await connect('round_close_block', null),
      a = await actor('round_close_round', owner),
      b = await connect('round_close_close');
    try {
      await block.query('BEGIN');
      await block.query('SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 FOR UPDATE', [
        x.club,
        x.payer,
      ]);
      const first = a.query(
        "SELECT fn_settle_round3_agents_to_players($1,'2026-08-31T00:00:00Z','2026-09-07T00:00:00Z') r",
        [union]
      );
      const waitA = await observedWait('round_close_round');
      const second = b.query('SELECT fn_close_settlement_period($1) r', [x.period]);
      const waitB = await observedWait('round_close_close');
      assert.equal(waitB.wait_event, 'advisory');
      await block.query('COMMIT');
      const [ra, rb] = await Promise.all([first, second]);
      assert.equal(ra.rows[0].r.amount + rb.rows[0].r.payout, 15);
      assert.equal((await snapshot(x)).payments, 1);
      results.push({ evidence: 'round3_close_observed_overlap', waitA, waitB });
    } finally {
      await Promise.all([block.end(), a.end(), b.end()]);
    }
  });
}
