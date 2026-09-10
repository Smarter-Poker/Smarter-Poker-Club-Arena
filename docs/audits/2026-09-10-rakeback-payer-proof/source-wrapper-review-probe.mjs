import assert from 'node:assert/strict';
export async function runReviewTests({
  q,
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
  let request = 910000;
  const actor = async (name, uid) => {
    const c = await connect(name, 'authenticated');
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
    return c;
  };
  const claim = async (c, club, req) =>
    (await c.query('SELECT fn_claim_captured_rakeback($1,auth.uid(),$2) result', [req, club]))
      .rows[0].result;
  await test('one hundred sequential fractional accrual and pay attempts preserve every funded cumulative cent', async () => {
    const x = await setup();
    let cents = 0;
    for (let i = 1; i <= 100; i++) {
      await source(x, { rake: '.01' });
      const r = await pay(x);
      cents += Math.round(r.new_payout * 100);
      assert.equal(cents, Math.floor((i * 15) / 100));
      assert.equal(r.source_final, false);
    }
    assert.equal(cents, 15);
    assert.equal((await snapshot(x)).player, '0.15');
  });
  await test('same request UUID observed concurrency returns byte-equivalent original receipt', async () => {
    const x = await setup();
    await source(x);
    const req = id(request++);
    const block = await connect('same_req_block', null),
      a = await actor('same_req_first', x.user),
      b = await actor('same_req_second', x.user);
    try {
      await block.query('BEGIN');
      await block.query('SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 FOR UPDATE', [
        x.club,
        x.payer,
      ]);
      const first = claim(a, x.club, req);
      const waitA = await observedWait('same_req_first');
      const second = claim(b, x.club, req);
      const waitB = await observedWait('same_req_second');
      assert.equal(waitB.wait_event, 'advisory');
      await block.query('COMMIT');
      const [ra, rb] = await Promise.all([first, second]);
      assert.equal(JSON.stringify(ra), JSON.stringify(rb));
      assert.equal(ra.total_payout, 15);
      assert.equal((await snapshot(x)).payments, 1);
      results.push({ evidence: 'same_uuid_request_observed_overlap', waitA, waitB });
    } finally {
      await Promise.all([block.end(), a.end(), b.end()]);
    }
  });
  await test('batch budget permits its first due attempt after an observed long scope wait', async () => {
    const x = await setup();
    await source(x);
    const block = await connect('budget_scope_block', null),
      c = await connect('budget_scope_batch');
    try {
      await block.query('BEGIN');
      await block.query('SELECT fn_lock_rakeback_payer_clubs(ARRAY[$1::uuid])', [x.club]);
      const call = c.query('SELECT fn_settle_club_rakeback_batch($1,1,.5,0) r', [x.club]);
      const wait = await observedWait('budget_scope_batch');
      assert.equal(wait.wait_event, 'advisory');
      await new Promise((resolve) => setTimeout(resolve, 650));
      await block.query('COMMIT');
      assert.equal((await call).rows[0].r.total_payout, 15);
      results.push({ evidence: 'batch_budget_scope_wait', wait });
    } finally {
      await Promise.all([block.end(), c.end()]);
    }
  });

  await test('expected actor mismatch refuses a stale account claim before payment', async () => {
    const x = await setup();
    await source(x);
    const c = await actor('wrong_expected_actor', x.user);
    try {
      await assert.rejects(
        c.query('SELECT fn_claim_captured_rakeback($1,$2,$3)', [
          id(request++),
          id(request++),
          x.club,
        ]),
        (e) => e.code === '42501'
      );
      assert.equal((await snapshot(x)).payments, 0);
    } finally {
      await c.end();
    }
  });
  await test('valid seventy-sixty rate source retains a fractional liability without paying an unearned cent', async () => {
    const x = await setup();
    await source(x, { rake: '.01', rate: '.60', direct: '.70' });
    const c = await actor('fractional_liability', x.user);
    try {
      const before = (await c.query('SELECT fn_get_captured_rakeback() r')).rows[0].r.periods[0];
      assert.equal(before.pending_amount, 0);
      assert.equal(before.exact_entitlement, 0.006);
      assert.equal(before.unpaid_exact_entitlement, 0.006);
      assert.equal(before.status, 'fraction_pending');
      const r = await claim(c, x.club, id(request++));
      assert.equal(r.total_payout, 0);
      assert.equal((await snapshot(x)).player, '0.00');
      assert.equal((await snapshot(x)).payer, '100.00');
    } finally {
      await c.end();
    }
  });
  await test('multi-club multi-week claim admits every club before taking its first period or wallet lock', async () => {
    const x = await setup(),
      other = await setup(),
      y = { ...other, user: x.user };
    await q(
      "INSERT INTO club_members(club_id,user_id,chip_balance,role,agent_id) VALUES($1,$2,0,'player',$3)",
      [y.club, y.user, y.payer]
    );
    await source(x);
    await source(x, { accepted: '2026-08-25', settled: '2026-08-25' });
    await source(y);
    const block = await connect('all_clubs_block', null),
      inspect = await connect('all_clubs_inspect', null),
      c = await actor('all_clubs_claim', x.user),
      batch = await connect('all_clubs_batch');
    try {
      await block.query('BEGIN');
      await block.query('SELECT fn_lock_rakeback_payer_clubs(ARRAY[$1::uuid])', [y.club]);
      const first = claim(c, null, id(request++));
      const wait = await observedWait('all_clubs_claim');
      assert.equal(wait.wait_event, 'advisory');
      await inspect.query('BEGIN');
      await inspect.query(
        'SELECT 1 FROM ca_rakeback_source_periods WHERE id=$1 FOR UPDATE NOWAIT',
        [x.period]
      );
      await inspect.query(
        'SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',
        [x.club, x.payer]
      );
      await inspect.query('COMMIT');
      const second = batch.query('SELECT fn_settle_club_rakeback_batch($1,40,30,0) r', [y.club]);
      await observedWait('all_clubs_batch');
      await block.query('COMMIT');
      const [ra, rb] = await Promise.all([first, second]);
      assert.equal(ra.total_payout + rb.rows[0].r.total_payout, 45);
      assert.equal(ra.periods.length, 3);
      results.push({ evidence: 'all_clubs_before_period_or_wallet', wait });
    } finally {
      await Promise.all([block.end(), inspect.end(), c.end(), batch.end()]);
    }
  });

  await test('synthetic generation and payload binding excludes unmarked and mismatched sources without a timestamp admission rule', async () => {
    const x = await setup({ start: '2024-12-30', end: '2025-01-05' });
    await source(x, {
      accepted: '2024-12-31T23:59:59Z',
      settled: '2024-12-31T23:59:59Z',
      generation: 1,
    });
    await source(x, { accepted: '2025-01-02', settled: '2025-01-02', generation: null });
    await source(x, {
      accepted: '2025-01-02',
      settled: '2025-01-02',
      receiptHash: 'contradictory-receipt',
    });
    const r = await pay(x);
    assert.equal(r.new_payout, 15);
    assert.equal((await snapshot(x)).accruals, 1);
    assert.equal((await snapshot(x)).payments, 1);
  });
  await test('early period refusals preserve identity and explicit zero payout for claim validation', async () => {
    const open = await setup({ start: '2099-01-05', end: '2099-01-11' });
    const missing = { period: id(990000) };
    for (const [x, reason] of [
      [open, 'period_not_closed'],
      [missing, 'period_not_found'],
    ]) {
      const r = await pay(x);
      assert.equal(r.success, false);
      assert.equal(r.period_id, x.period);
      assert.equal(r.new_payout, 0);
      assert.equal(r.source_accruals_added, 0);
      assert.equal(r.source_final, false);
      assert.deepEqual(r.paid_receipts, []);
      assert.deepEqual(r.deferred, [{ reason }]);
    }
  });
}
