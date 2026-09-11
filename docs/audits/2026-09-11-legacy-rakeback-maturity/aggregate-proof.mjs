// Actual captured-owner aggregate and rolling replacement proofs; private fixture only.
export async function proveLegacyAggregate(ctx) {
  const {
    assert,
    query,
    reset,
    snapshot,
    client,
    observeWait,
    test,
    outcomes,
    uid,
    readFileSync,
    rootURL,
    claimSql,
    closeSql,
  } = ctx;
  const wide =
    "SELECT public.fn_settle_round3_agents_to_players('" +
    uid(999) +
    "','2026-08-24T00:00:00Z','2026-09-07T00:00:00Z') result";
  const catalogue = JSON.parse(readFileSync(new URL('installed-catalog.json', rootURL), 'utf8'));
  const original = (prefix) =>
    catalogue.functions.find((f) => f.signature.startsWith(prefix)).definition;
  const installed = {};
  for (const name of [
    'fn_claim_rakeback(uuid)',
    'fn_close_settlement_period(uuid)',
    'fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)',
  ])
    installed[name] = (
      await query('SELECT pg_get_functiondef($1::regprocedure) body', [name])
    )[0].body;
  let ledgerBefore = new Set(),
    moneyBefore;
  async function checkpoint() {
    ledgerBefore = new Set((await query('SELECT id FROM chip_ledger')).map((r) => r.id));
    moneyBefore = await snapshot();
  }
  async function two(agent = 15) {
    await reset({ agent, treasury: 100 });
    await query(
      "INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned) VALUES($1,$2,$3,'2026-08-24','2026-08-30',100,.15,15,15)",
      [uid(502), uid(201), uid(900)]
    );
    await query(
      "INSERT INTO rakeback_daily_state(club_id,day,rows_seen) SELECT $1,d::date,1 FROM generate_series('2026-08-24'::date,'2026-08-30'::date,'1 day')d",
      [uid(900)]
    );
    await query(
      "INSERT INTO rakeback_daily_user(club_id,day,user_id,cents) VALUES($1,'2026-08-24',$2,10000)",
      [uid(900), uid(201)]
    );
    await checkpoint();
  }
  async function assertPaid30() {
    const state = await snapshot();
    assert.equal(state.player, '30.00');
    assert.equal(state.receipts, 2);
    assert.equal(state.wallet_rows, 2);
    const legs = (
      await query(
        'SELECT id,from_type,from_entity_id,to_type,to_entity_id,amount,category FROM chip_ledger'
      )
    ).filter((r) => !ledgerBefore.has(r.id));
    let treasury = 0,
      agent = 0,
      player = 0,
      suspense = 0;
    for (const leg of legs) {
      assert.equal(Number(leg.amount), 15);
      if (
        leg.from_type === 'club_treasury' &&
        leg.from_entity_id === uid(900) &&
        leg.to_type === 'settlement_suspense'
      ) {
        treasury += 15;
        suspense += 15;
      } else if (
        leg.from_type === 'settlement_suspense' &&
        leg.to_type === 'player_wallet' &&
        leg.to_entity_id === uid(201)
      ) {
        player += 15;
        suspense -= 15;
        assert.equal(leg.category, 'rakeback');
      } else if (
        leg.from_type === 'player_wallet' &&
        leg.from_entity_id === uid(101) &&
        leg.to_type === 'player_wallet' &&
        leg.to_entity_id === uid(201)
      ) {
        agent += 15;
        player += 15;
        assert.equal(leg.category, 'rakeback');
      } else assert.fail('Unexpected journal endpoint ' + JSON.stringify(leg));
    }
    assert.equal(treasury, Number(moneyBefore.treasury) - Number(state.treasury));
    assert.equal(agent, Number(moneyBefore.agent) - Number(state.agent));
    assert.equal(player, 30);
    assert.equal(suspense, 0);
    assert.equal(legs.length, (treasury / 15) * 2 + agent / 15);
    outcomes.push({
      evidence: 'exact_funding_journal',
      moneyBefore,
      state,
      legs,
      treasury_debits: treasury,
      agent_debits: agent,
      player_credits: player,
      suspense_net: suspense,
    });
    const receipts = await query(
      'SELECT count(*)::int n FROM rakeback_period_payouts p JOIN wallet_transactions w ON w.id=p.wallet_transaction_id AND w.related_entity_id=p.id AND w.user_id=p.user_id AND w.amount=p.payout_amount'
    );
    assert.equal(receipts[0].n, 2);
    assert.deepEqual(
      (await query('SELECT status FROM rakeback_periods ORDER BY id')).map((r) => r.status),
      ['paid', 'paid']
    );
    return state;
  }
  await test('actual two-period aggregate shortfall defers both then funded retry pays exact receipts once', async () => {
    await two();
    const before = await snapshot();
    const result = (await query(wide))[0].result;
    assert.equal(result.amount, 0);
    assert.equal(result.payees, 0);
    assert.equal(result.shortfalls, 1);
    assert.equal(result.detail[0].owed, 30);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      (await query('SELECT status FROM rakeback_periods ORDER BY id')).map((r) => r.status),
      ['pending', 'pending']
    );
    await query('UPDATE club_members SET chip_balance=30 WHERE user_id=$1', [uid(101)]);
    await checkpoint();
    const paid = (await query(wide))[0].result;
    assert.equal(paid.amount, 30);
    assert.equal(paid.payees, 1);
    assert.equal(paid.shortfalls, 0);
    const state = await assertPaid30();
    assert.equal(state.agent, '0.00');
    assert.equal(state.treasury, '100.00');
    assert.equal((await query(wide))[0].result.amount, 0);
    assert.deepEqual(await snapshot(), state);
    outcomes.push({
      evidence: 'aggregate_shortfall_retry',
      shortfall: result,
      funded: paid,
      state,
    });
  });
  await test('original two-period claim category leak is preserved as evidence and corrected close restores caller context', async () => {
    await two(100);
    await query(original('fn_claim_rakeback('));
    await query(original('fn_close_settlement_period('));
    const actor = await client('original_category_claim', 'authenticated');
    try {
      await actor.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(201)]);
      const old = (await actor.query(claimSql)).rows[0].result;
      assert.equal(old.total_payout, 30);
      const oldState = await snapshot();
      assert.equal(oldState.player, '30.00');
      assert.equal(oldState.receipts, 2);
      assert.equal(oldState.wallet_rows, 2);
      assert.equal(oldState.legs, 3);
      const oldLegs = (
        await query(
          'SELECT id,from_type,from_entity_id,to_type,to_entity_id,amount,category FROM chip_ledger'
        )
      ).filter((r) => !ledgerBefore.has(r.id));
      assert.equal(oldLegs.length, 4);
      assert.deepEqual(
        oldLegs
          .filter((r) => r.from_type === 'club_treasury')
          .map((r) => r.category)
          .sort(),
        ['adjustment', 'rakeback']
      );
      outcomes.push({
        evidence: 'preserved_original_category_leak',
        result: old,
        state: oldState,
        legs: oldLegs,
      });
    } finally {
      await query(installed['fn_close_settlement_period(uuid)']);
      await query(installed['fn_claim_rakeback(uuid)']);
      await actor.end();
    }
    await two(100);
    const fixed = await client('scoped_category_claim', 'authenticated');
    try {
      await fixed.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(201)]);
      await fixed.query('BEGIN');
      await fixed.query("SELECT set_config('app.ledger_category','commission',true)");
      assert.equal((await fixed.query(claimSql)).rows[0].result.total_payout, 30);
      assert.equal(
        (await fixed.query("SELECT current_setting('app.ledger_category') value")).rows[0].value,
        'commission'
      );
      await fixed.query('COMMIT');
      await assertPaid30();
      const legs = (await query('SELECT id,from_type,category FROM chip_ledger')).filter(
        (r) => !ledgerBefore.has(r.id)
      );
      assert.deepEqual(
        legs.filter((r) => r.from_type === 'club_treasury').map((r) => r.category),
        ['commission', 'commission']
      );
    } finally {
      await fixed.query('ROLLBACK');
      await fixed.end();
    }
  });
  for (const bad of ['negative', 'missing_rate', 'missing_basis'])
    await test(
      'malformed ' + bad + ' legacy basis refuses without discarding aggregate members',
      async () => {
        await two(100);
        await query(
          bad === 'negative'
            ? 'UPDATE rakeback_periods SET rakeback_amount=-5 WHERE id=$1'
            : bad === 'missing_basis'
              ? 'UPDATE rakeback_periods SET rake_generated=NULL,total_rake_paid=NULL WHERE id=$1'
              : 'UPDATE rakeback_periods SET rakeback_rate=NULL WHERE id=$1',
          [uid(502)]
        );
        const before = await snapshot(),
          periods = await query('SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id');
        await assert.rejects(
          query(wide),
          (e) =>
            e.code === '23514' &&
            e.message ===
              (bad === 'negative'
                ? 'Legacy rakeback aggregate contains a negative period'
                : 'Legacy rakeback receipt basis requires repair')
        );
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(
          await query('SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id'),
          periods
        );
      }
    );
  for (const paidCount of [1, 2])
    await test(
      'actual running old Round3 ' +
        (paidCount === 2 ? 'all' : 'partially') +
        ' stale two-period set rolls back after body replacement',
      async () => {
        await two(100);
        await query(original('fn_settle_round3_agents_to_players('));
        const blocker = await client('old_round3_blocker_' + paidCount, null),
          old = await client('old_round3_running_' + paidCount, 'service_role');
        try {
          await old.query("SET statement_timeout='7s'");
          await blocker.query('BEGIN');
          await blocker.query('SELECT 1 FROM club_members WHERE user_id=$1 FOR UPDATE', [uid(101)]);
          const pending = old.query(wide).then(
            (v) => ({ rows: v.rows }),
            (e) => ({ error: { code: e.code, message: e.message } })
          );
          const wait = await observeWait(ctx.db, 'old_round3_running_' + paidCount);
          await query(
            installed['fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)']
          );
          assert.equal((await query(closeSql))[0].result.payout, 15);
          if (paidCount === 2)
            assert.equal(
              (await query('SELECT fn_close_settlement_period($1) result', [uid(502)]))[0].result
                .payout,
              15
            );
          const before = await snapshot(),
            periods = await query(
              'SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id'
            );
          await blocker.query('COMMIT');
          const result = await pending;
          assert.equal(result.error?.code, '23514');
          assert.equal(result.error.message, 'Round3 requires the unique unpaid period receipt');
          assert.deepEqual(await snapshot(), before);
          assert.deepEqual(
            await query('SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id'),
            periods
          );
          const retry = (await query(wide))[0].result;
          assert.equal(retry.amount, paidCount === 1 ? 15 : 0);
          const state = await assertPaid30();
          assert.equal(state.treasury, paidCount === 1 ? '85.00' : '70.00');
          assert.equal(state.agent, paidCount === 1 ? '85.00' : '100.00');
          outcomes.push({
            evidence: 'running_old_round3_' + paidCount + '_stale',
            wait,
            body_replaced_while_waiting: true,
            table_fence_installed_before_call: true,
            result,
            retry,
            state,
          });
        } finally {
          await blocker.query('ROLLBACK');
          await query(
            installed['fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)']
          );
          await Promise.all([old.end(), blocker.end()]);
        }
      }
    );
  for (const victim of ['claim', 'weekly'])
    await test(
      'observed old multi-period claim crossing replacement with ' +
        victim +
        ' deadlock victim resolves atomically and retries once',
      async () => {
        await two(100);
        await query(original('fn_claim_rakeback('));
        const blocker = await client('rolling_claim_blocker', null),
          old = await client('rolling_old_claim', 'authenticated'),
          weekly = await client('rolling_new_weekly', 'service_role');
        try {
          await old.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(201)]);
          await old.query("SET statement_timeout='7s'");
          await weekly.query("SET statement_timeout='7s'");
          await old.query(
            "RESET ROLE; SET deadlock_timeout='" +
              (victim === 'claim' ? '200ms' : '2s') +
              "'; SET ROLE authenticated"
          );
          await weekly.query(
            "RESET ROLE; SET deadlock_timeout='" +
              (victim === 'weekly' ? '200ms' : '2s') +
              "'; SET ROLE service_role"
          );
          await blocker.query('BEGIN');
          await blocker.query('SELECT 1 FROM rakeback_periods WHERE id=$1 FOR UPDATE', [uid(502)]);
          const a = old.query(claimSql).then(
            (v) => ({ rows: v.rows }),
            (e) => ({ error: { code: e.code, message: e.message } })
          );
          const waitOld = await observeWait(ctx.db, 'rolling_old_claim');
          await query(installed['fn_claim_rakeback(uuid)']);
          const b = weekly.query(wide).then(
            (v) => ({ rows: v.rows }),
            (e) => ({ error: { code: e.code, message: e.message } })
          );
          const waitNew = await observeWait(ctx.db, 'rolling_new_weekly');
          await blocker.query('COMMIT');
          const results = await Promise.all([a, b]);
          const errors = results.filter((r) => r.error);
          assert.equal(errors.length, 1);
          assert.equal(errors[0].error.code, '40P01');
          assert.equal(results[victim === 'claim' ? 0 : 1].error?.code, '40P01');
          console.log('ROLLING_RESULTS', JSON.stringify(results));
          const state = await assertPaid30();
          assert.equal(Number(state.treasury) + Number(state.agent) + Number(state.player), 200);
          const retryClaim = (await old.query(claimSql)).rows[0].result,
            retryWeekly = (await weekly.query(wide)).rows[0].result;
          assert.equal(retryClaim.total_payout, 0);
          assert.equal(retryWeekly.amount, 0);
          assert.deepEqual(await snapshot(), state);
          outcomes.push({
            evidence: 'rolling_old_multiperiod_claim',
            selected_deadlock_victim: victim,
            detector_timeouts_ms: { preferred: 200, other: 2000 },
            waitOld,
            waitNew,
            body_replaced_while_waiting: true,
            results,
            retryClaim,
            retryWeekly,
            state,
            limit:
              'PostgreSQL deadlock aborts one old/new transaction; caller retry remains necessary.',
          });
        } finally {
          await blocker.query('ROLLBACK');
          await query(installed['fn_claim_rakeback(uuid)']);
          await Promise.all([old.end(), weekly.end(), blocker.end()]);
        }
      }
    );
}
