import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fixture from './runtime-fixture.mjs';

async function moreTargets(x, f, extra = 500) {
  await x.c.query('BEGIN;SET LOCAL session_replication_role=replica');
  await x.c.query(
    `INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,reversible_until)
    SELECT gen_random_uuid(),t.club_id,t.from_user_id,t.to_user_id,t.amount,t.transaction_type,t.reversible_until
    FROM public.chip_transactions t CROSS JOIN generate_series(1,$2::integer) WHERE t.id=$1`,
    [f.tx, extra]
  );
  await x.c.query('COMMIT');
}
const full = (t) => t.kind === 'rpc_commit' && t.name === 'fn_ack_engine_maintenance_resumed';
async function facts(x, hold) {
  return (
    await x.c.query(
      `SELECT
    (SELECT to_jsonb(r) FROM release_ops.maintenance_global_receipts r WHERE interval_id=$1) receipt,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY checkpoint_no) FROM release_ops.maintenance_global_checkpoints c WHERE interval_id=$1) checkpoints,
    (SELECT count(*) FROM public.engine_maintenance_thaw_targets t JOIN release_ops.maintenance_target_scope s USING(freeze_started_at,step,target_id)
     WHERE t.freeze_started_at=$2 AND cardinality(s.table_ids)=0 AND t.credited_seconds<>(SELECT extract(epoch FROM release_at-$2::timestamptz) FROM release_ops.maintenance_global_receipts WHERE interval_id=$1)) omitted,
    public.fn_platform_frozen() frozen,public.fn_entry_purchases_frozen() purchases`,
      [hold.s.interval_id, hold.s.freeze_started_at]
    )
  ).rows[0];
}

export async function globalTailCases({ test, setup, prepared, until, evidence }) {
  await test('global_501_targets_complete_stable_batches_without_repeating_waves', async () => {
    const x = await setup('global_501');
    const hold = await prepared(x),
      f = await fixture.seedClocks(x.c, hold.s);
    await moreTargets(x, f);
    await fixture.release(x.c, hold.o, hold.s);
    await until(
      () => x.trace.some((t) => full(t) && t.data.operation.global_tail?.receipt_id),
      'committed certificate before restart',
      100000
    );
    const originalCertificate = x.trace.find(
      (t) => full(t) && t.data.operation.global_tail?.receipt_id
    ).data.operation.global_tail.receipt_id;
    await x.restart();
    await until(
      () => x.runtime.snapshot().operation?.phase === 'resumed',
      '501-target global completion',
      100000
    );
    const calls = x.trace.filter(full),
      pending = calls.filter((t) => !t.data.operation.global_tail?.receipt_id);
    assert.ok(pending.length >= 2, 'At least three bounded installments must process 501 rows');
    assert.equal(new Set(calls.map((t) => t.data.operation.global_tail.checkpoint_id)).size, 1);
    assert.ok(
      pending.every(
        (t) => t.data.operation.phase === 'releasing' && t.data.operation.global_tail.remaining > 0
      )
    );
    const fct = await facts(x, hold);
    assert.equal(Number(fct.omitted), 0);
    assert.equal(fct.frozen, false);
    assert.equal(fct.purchases, false);
    assert.equal(fct.receipt.step_counts.reversible_until, 501);
    assert.equal(fct.receipt.wave_receipts.length, 2);
    assert.equal(fct.receipt.id, originalCertificate);
    assert.equal(
      x.trace.filter(
        (t) => t.kind === 'rpc_commit' && t.name === 'fn_claim_engine_maintenance_operation'
      ).length,
      2
    );
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      [1, 1, 1]
    );
    assert.equal(x.runtime.snapshot().releaseInDoubt, false);
    assert.deepEqual(x.errors, []);
    const before = JSON.stringify(fct);
    const owned = x.runtime.snapshot().operation;
    const repeat = await fixture.engine(x.c, 'fn_ack_engine_maintenance_resumed', [
      hold.s.interval_id,
      owned.ownershipToken,
      fct.receipt.wave_receipts.map((w) => w.receipt_id),
    ]);
    assert.equal(repeat.operation.global_tail.receipt_id, fct.receipt.id);
    assert.equal(
      JSON.stringify(await facts(x, hold)),
      before,
      'Exact replay writes no clocks or certificate'
    );
    await writeFile(
      join(evidence, 'global-501-proof.json'),
      JSON.stringify({ calls, facts: fct }, null, 2)
    );
  });

  await test('global_overrun_finishes_old_checkpoint_then_recovers_lost_certificate_reply', async () => {
    let delayed = false,
      lost = false;
    const x = await setup('global_overrun', {
      afterRpc: async (h) => {
        if (
          h.name === 'fn_ack_engine_maintenance_resumed' &&
          !h.data.operation.global_tail.receipt_id &&
          !delayed
        ) {
          delayed = true;
          await sleep(
            Math.max(
              1,
              Date.parse(h.data.operation.global_tail.credited_through_at) - Date.now() + 40
            )
          );
          assert.equal(await fixture.call(h.c, 'public.fn_platform_frozen', []), true);
        }
      },
      fault: async (h) => {
        if (h.name === 'fn_ack_engine_maintenance_resumed') {
          const data = await h.query();
          if (!data.operation.global_tail?.receipt_id && !delayed) {
            delayed = true;
            h.record('lost_committed_global_checkpoint', { data });
            await sleep(
              Math.max(
                1,
                Date.parse(data.operation.global_tail.credited_through_at) - Date.now() + 40
              )
            );
            assert.equal(await fixture.call(h.c, 'public.fn_platform_frozen', []), true);
            throw new Error('injected lost committed global checkpoint reply');
          }
          if (data.operation.global_tail?.receipt_id && !lost) {
            lost = true;
            h.record('lost_committed_global_certificate', { data });
            throw new Error('injected lost committed global certificate reply');
          }
          return { handled: true, data };
        }
      },
    });
    const hold = await prepared(x),
      f = await fixture.seedClocks(x.c, hold.s);
    await moreTargets(x, f);
    await fixture.release(x.c, hold.o, hold.s);
    await until(
      () => x.runtime.snapshot().operation?.phase === 'resumed',
      'overrun and lost reply convergence',
      120000
    );
    const fct = await facts(x, hold);
    assert.equal(delayed, true);
    assert.equal(lost, true);
    assert.equal(fct.checkpoints.length, 2);
    assert.ok(
      Date.parse(fct.checkpoints[0].completed_at) >=
        Date.parse(fct.checkpoints[0].credited_through_at)
    );
    assert.ok(
      Date.parse(fct.checkpoints[1].created_at) >= Date.parse(fct.checkpoints[0].completed_at)
    );
    assert.equal(Number(fct.omitted), 0);
    assert.equal(fct.frozen, false);
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      [1, 1, 1]
    );
    assert.equal(x.runtime.snapshot().releaseInDoubt, false);
    assert.ok(
      x.errors.every((e) => /injected lost committed global (certificate|checkpoint) reply/.test(e))
    );
    await writeFile(
      join(evidence, 'global-overrun-lost-reply-proof.json'),
      JSON.stringify(fct, null, 2)
    );
  });

  await test('global_pending_checkpoint_time_and_stale_writer_never_release', async () => {
    let gateResolve;
    const gate = new Promise((resolve) => {
      gateResolve = resolve;
    });
    let entered = false;
    const x = await setup('global_pending', {
      afterRpc: async (h) => {
        if (h.name === 'fn_ack_engine_maintenance_resumed' && !entered) {
          entered = true;
          await gate;
        }
      },
    });
    try {
      const hold = await prepared(x),
        f = await fixture.seedClocks(x.c, hold.s);
      await moreTargets(x, f);
      await fixture.release(x.c, hold.o, hold.s);
      await until(() => entered, 'first partial installment', 100000);
      const p = x.trace.find(full).data.operation.global_tail;
      await sleep(Math.max(1, Date.parse(p.credited_through_at) - Date.now() + 30));
      assert.equal(await fixture.call(x.c, 'public.fn_platform_frozen', []), true);
      assert.equal(await fixture.call(x.c, 'public.fn_entry_purchases_frozen', []), true);
      const view = await fixture.call(x.c, 'public.fn_maintenance_break_state_v2', [
        null,
        hold.s.interval_id,
      ]);
      assert.equal(view.active, true);
      assert.equal(view.global_release_receipt, null);
      assert.equal(x.mods.freeze.isMaintenanceFrozen(), true);
      const rows = (
        await x.c.query('SELECT count(*) n FROM release_ops.maintenance_global_receipts')
      ).rows[0];
      assert.equal(Number(rows.n), 0);
      await assert.rejects(
        () =>
          fixture.engine(x.c, 'fn_ack_engine_maintenance_resumed', [
            hold.s.interval_id,
            randomUUID(),
            [],
          ]),
        /STALE_ENGINE_OWNER/
      );
      await fixture.engine(x.c, 'fn_engine_maintenance_recovery', [
        hold.s.interval_id,
        x.runtime.snapshot().operation.ownershipToken,
        'native explicit recovery',
      ]);
      gateResolve();
      await until(
        () => x.runtime.snapshot().operation?.phase === 'recovering',
        'explicit recovery readback'
      );
      assert.equal(await fixture.call(x.c, 'public.fn_platform_frozen', []), true);
    } finally {
      gateResolve();
    }
  });

  await test('early_wave_addon_opportunity_survives_global_purchasing_tail_and_replay', async () => {
    let heldAfterOpportunity;
    const x = await setup('addon_global_opportunity', {
      afterRpc: async (h) => {
        if (h.name !== 'fn_ack_engine_maintenance_wave' || h.args.p_wave_index !== 0) return;
        // The first event is physically resumed and its ACK is committed, but
        // later waves and purchasing are held beyond its original 1s offer.
        await sleep(1300);
        heldAfterOpportunity = (
          await h.c.query(
            `SELECT public.fn_entry_purchases_frozen() purchases,
              addon_period_ends_at<=clock_timestamp() old_opportunity_elapsed,
              (SELECT table_ids FROM release_ops.maintenance_target_scope
               WHERE freeze_started_at=$1 AND step='addon_period_ends_at' AND target_id=$2) scope
             FROM public.tournaments WHERE id=$2`,
            [h.data.operation.freeze_started_at, x.base.event]
          )
        ).rows[0];
        assert.equal(heldAfterOpportunity.purchases, true);
        assert.equal(heldAfterOpportunity.old_opportunity_elapsed, true);
        assert.deepEqual(heldAfterOpportunity.scope, []);
      },
    });
    const hold = await prepared(x),
      f = await fixture.seedClocks(x.c, hold.s);
    await x.c.query('BEGIN;SET LOCAL session_replication_role=replica');
    await x.c.query(
      `UPDATE public.tournaments SET addon_period_ends_at=$1::timestamptz+interval '1second' WHERE id=$2`,
      [hold.s.freeze_started_at, x.base.event]
    );
    await x.c.query('COMMIT');
    const before = (
      await x.c.query('SELECT started_at FROM public.tournaments WHERE id=$1', [x.base.event])
    ).rows[0];
    await fixture.release(x.c, hold.o, hold.s);
    await until(
      () => x.runtime.snapshot().operation?.phase === 'resumed',
      'global purchasing release',
      35000
    );
    const read = async () =>
      (
        await x.c.query(
          `SELECT t.started_at,t.addon_period_ends_at,t.level_started_at,
          public.fn_entry_purchases_frozen() purchases,
          t.addon_period_ends_at>clock_timestamp() opportunity_open,
          extract(epoch FROM t.addon_period_ends_at-r.release_at)*1000 opportunity_ms,
          extract(epoch FROM r.release_at-w.resumed_at)*1000 global_tail_after_event_ms,
          to_jsonb(r) receipt,
          (SELECT jsonb_agg(to_jsonb(z) ORDER BY step,target_id) FROM public.engine_maintenance_thaw_targets z WHERE freeze_started_at=$2) targets
         FROM public.tournaments t JOIN release_ops.maintenance_global_receipts r ON r.interval_id=$1
         JOIN release_ops.maintenance_waves w ON w.interval_id=r.interval_id AND w.wave_index=0
         WHERE t.id=$3`,
          [hold.s.interval_id, hold.s.freeze_started_at, x.base.event]
        )
      ).rows[0];
    const after = await read();
    assert.ok(heldAfterOpportunity);
    assert.equal(after.purchases, false);
    assert.equal(after.opportunity_open, true);
    assert.equal(Number(after.opportunity_ms), 1000);
    assert.ok(Number(after.global_tail_after_event_ms) > 1000);
    assert.deepEqual(
      after.started_at,
      before.started_at,
      'Minute late registration retains its wall-clock anchor'
    );
    const wave = after.receipt.wave_receipts[0];
    assert.equal(
      new Date(after.level_started_at).getTime() - new Date(f.before).getTime(),
      Date.parse(wave.resumed_at) - Date.parse(hold.s.freeze_started_at)
    );
    const addon = after.targets.find((t) => t.step === 'addon_period_ends_at');
    assert.equal(
      Number(addon.credited_seconds),
      (Date.parse(after.receipt.release_at) - Date.parse(hold.s.freeze_started_at)) / 1000
    );
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      [1, 1, 1]
    );
    const current = x.runtime.snapshot().operation;
    const replay = await fixture.engine(x.c, 'fn_ack_engine_maintenance_resumed', [
      hold.s.interval_id,
      current.ownershipToken,
      after.receipt.wave_receipts.map((w) => w.receipt_id),
    ]);
    assert.equal(replay.operation.global_tail.receipt_id, after.receipt.id);
    const repeated = await read();
    for (const key of [
      'started_at',
      'addon_period_ends_at',
      'level_started_at',
      'receipt',
      'targets',
    ])
      assert.deepEqual(repeated[key], after[key], 'Replay cannot add credit: ' + key);
    assert.deepEqual(x.errors, []);
    await writeFile(
      join(evidence, 'addon-global-opportunity-proof.json'),
      JSON.stringify(
        { heldAfterOpportunity, before, after, replay: replay.operation.global_tail },
        null,
        2
      )
    );
  });

  await test('global_all14_clock_classes_certify_exact_boundary_and_cold_restart_readback', async () => {
    const x = await setup('global_all14');
    // A private fixture with no locally admitted engine tables leaves all legacy
    // ancillary clock rows globally held. The actual target snapshot and worker
    // classify/credit all 14 classes; no target scope or writer is stubbed.
    const h = await fixture.fixtureHold(x.c, { seconds: 960, plan: false, admittedTables: [] });
    h.s = (await fixture.ready(x.c, h.s, [])).operation;
    const f = await fixture.seedClocks(x.c, h.s);
    h.s = (await fixture.release(x.c, h.o, h.s)).s;
    const baseThaw = await fixture.thaw(x.c, h.s);
    await sleep(Math.max(0, Date.parse(baseThaw.credited_through_at) - Date.now() + 10));
    const beforeDelayedCertificate = await fixture.clockReceipt(x.c, h.s, f);
    await x.c
      .query(`CREATE FUNCTION pg_temp.delay_native_global_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(GREATEST(0,extract(epoch FROM NEW.release_at-clock_timestamp()))+0.05); RETURN NEW; END $$;
      CREATE TRIGGER native_delay_global_certificate BEFORE INSERT ON public.engine_maintenance_global_releases FOR EACH ROW EXECUTE FUNCTION pg_temp.delay_native_global_certificate()`);
    await assert.rejects(
      () =>
        fixture.engine(x.c, 'fn_ack_engine_maintenance_resumed', [
          h.s.interval_id,
          h.s.ownership_token,
          [],
        ]),
      /GLOBAL_CERTIFICATE_ENDPOINT_ELAPSED/
    );
    await x.c.query(
      'DROP TRIGGER native_delay_global_certificate ON public.engine_maintenance_global_releases'
    );
    assert.equal(
      Number(
        (await x.c.query('SELECT count(*) n FROM release_ops.maintenance_global_receipts')).rows[0]
          .n
      ),
      0
    );
    assert.equal(
      Number(
        (await x.c.query('SELECT count(*) n FROM public.engine_maintenance_global_releases'))
          .rows[0].n
      ),
      0
    );
    assert.equal(await fixture.call(x.c, 'public.fn_platform_frozen', []), true);
    assert.deepEqual(
      await fixture.clockReceipt(x.c, h.s, f),
      beforeDelayedCertificate,
      'Deferred finalization refusal rolls back every uncommitted suffix'
    );
    let response = await fixture.engine(x.c, 'fn_ack_engine_maintenance_resumed', [
      h.s.interval_id,
      h.s.ownership_token,
      [],
    ]);
    while (!response.operation.global_tail?.receipt_id) {
      response = await fixture.engine(x.c, 'fn_ack_engine_maintenance_resumed', [
        h.s.interval_id,
        h.s.ownership_token,
        [],
      ]);
    }
    const tail = response.operation.global_tail;
    assert.equal(tail.status, 'certified');
    const preserved = await fixture.engine(x.c, 'fn_engine_maintenance_recovery', [
      h.s.interval_id,
      h.s.ownership_token,
      'late report after committed certificate',
    ]);
    assert.equal(preserved.operation.phase, 'releasing');
    assert.equal(preserved.operation.global_tail.receipt_id, tail.receipt_id);
    await assert.rejects(
      () =>
        x.c.query(
          "UPDATE release_ops.maintenance_operations SET phase='recovering' WHERE interval_id=$1",
          [h.s.interval_id]
        ),
      /GLOBAL_RELEASE_ALREADY_CERTIFIED/
    );
    await assert.rejects(
      () =>
        x.c.query(
          "UPDATE release_ops.maintenance_operations SET phase='resumed',resumed_at=clock_timestamp() WHERE interval_id=$1",
          [h.s.interval_id]
        ),
      /GLOBAL_RELEASE_ALREADY_CERTIFIED/
    );

    assert.equal(await fixture.call(x.c, 'public.fn_platform_frozen', []), true);
    const bound = (
      await x.c.query(
        'SELECT * FROM release_ops.maintenance_global_receipts WHERE interval_id=$1',
        [h.s.interval_id]
      )
    ).rows[0];
    assert.equal(Object.keys(bound.step_counts).length, 14);
    await assert.rejects(
      () =>
        fixture.as(x.c, 'service_role', () =>
          x.c.query(
            'INSERT INTO public.engine_maintenance_global_releases SELECT * FROM public.engine_maintenance_global_releases'
          )
        ),
      /permission denied/
    );
    await assert.rejects(
      () =>
        fixture.as(x.c, 'service_role', () =>
          x.c.query(
            'UPDATE release_ops.maintenance_global_checkpoints SET completed_at=clock_timestamp()'
          )
        ),
      /permission denied/
    );
    const newToken = randomUUID();
    const adopted = await fixture.engine(x.c, 'fn_claim_engine_maintenance_operation', [
      h.s.interval_id,
      h.s.ownership_token,
      newToken,
      'native certificate adoption',
    ]);
    assert.equal(adopted.operation.global_tail.receipt_id, tail.receipt_id);
    assert.equal(adopted.operation.global_tail.receipt_ownership_token, h.s.ownership_token);
    await assert.rejects(
      () =>
        fixture.engine(x.c, 'fn_ack_engine_maintenance_resumed', [
          h.s.interval_id,
          h.s.ownership_token,
          [],
        ]),
      /STALE_ENGINE_OWNER/
    );
    await sleep(Math.max(1, Date.parse(tail.credited_through_at) - Date.now() + 30));
    // No timer, snapshot RPC or bookkeeping mutation has run after the boundary.
    assert.equal(
      (
        await x.c.query(
          'SELECT phase FROM release_ops.maintenance_operations WHERE interval_id=$1',
          [h.s.interval_id]
        )
      ).rows[0].phase,
      'releasing'
    );
    assert.equal(await fixture.call(x.c, 'public.fn_platform_frozen', []), false);
    assert.equal(await fixture.call(x.c, 'public.fn_entry_purchases_frozen', []), false);
    const publicView = await fixture.call(x.c, 'public.fn_maintenance_break_state_v2', [
      null,
      h.s.interval_id,
    ]);
    assert.equal(publicView.active, false);
    assert.equal(publicView.release_receipt, tail.receipt_id);
    const before = await fixture.clockReceipt(x.c, h.s, f);
    assert.ok(
      before.targets.every(
        (t) =>
          Math.abs(
            Number(t.credited_seconds) -
              (Date.parse(tail.credited_through_at) - Date.parse(h.s.freeze_started_at)) / 1000
          ) < 1e-8
      )
    );
    assert.equal(
      before.reconnect.expired.reconnectDeadlineMs,
      f.reconnect.expired.reconnectDeadlineMs
    );
    await x.start();
    assert.equal(x.runtime.active(), false);
    assert.equal(x.mods.freeze.isMaintenanceFrozen(), false);
    assert.deepEqual(
      [...x.engines.values()].map((e) => e.resumes),
      [0, 0, 0]
    );
    assert.deepEqual(await fixture.clockReceipt(x.c, h.s, f), before);
    await writeFile(
      join(evidence, 'global-all14-cold-readback-proof.json'),
      JSON.stringify(
        { certificate: bound, publicView, clocks: before, snapshot: x.runtime.snapshot() },
        null,
        2
      )
    );
  });
}
