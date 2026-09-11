import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fixture from './runtime-fixture.mjs';

/** Native checkpointed fractional endpoint, not a fabricated RPC response. */
export async function precisionCase({ setup, prepared, until, evidence }) {
  let checkpointed = false,
    checked = false;
  const precision = [];
  const x = await setup('microseconds', {
    fault: async (h) => {
      if (
        h.name === 'fn_authorize_engine_maintenance_wave' &&
        h.args.p_wave_index === 0 &&
        !checkpointed
      ) {
        checkpointed = true;
        const row = await fixture.one(
          h.c,
          "UPDATE release_ops.maintenance_waves SET credited_through_at=date_trunc('milliseconds',clock_timestamp())+interval '5.000501 seconds' WHERE interval_id=$1 AND wave_index=0 AND receipt_id IS NULL RETURNING credited_through_at::text raw",
          [h.args.p_interval_id]
        );
        precision.push({ checkpoint: row.raw });
      }
    },
    afterRpc: async (h) => {
      if (h.name !== 'fn_authorize_engine_maintenance_wave' || h.args.p_wave_index !== 0 || checked)
        return;
      const wave = h.data.operation.resume_waves[0];
      if (!wave.receipt_id) return;
      checked = true;
      const raw = wave.credited_through_at;
      const fraction = await fixture.one(
        h.c,
        'SELECT extract(microseconds FROM $1::timestamptz)::numeric % 1000 remainder',
        [raw]
      );
      assert.equal(Number(fraction.remainder), 501);
      const truncated = new Date(Date.parse(raw)).toISOString();
      // Wait until both values are past: refusal then specifically proves that a
      // truncated lower boundary is still earlier than the exact credited target.
      await sleep(Math.max(0, Date.parse(raw) - Date.now()) + 30);
      await assert.rejects(
        fixture.engine(h.c, 'fn_ack_engine_maintenance_wave', [
          h.args.p_interval_id,
          h.args.p_ownership_token,
          0,
          wave.receipt_id,
          wave.table_ids,
          truncated,
        ]),
        /MAINTENANCE_ACTUAL_RESUME_TIME_INVALID/
      );
      const before = await fixture.call(h.c, 'public.fn_maintenance_break_state_v2', [
        wave.table_ids[0],
        h.args.p_interval_id,
      ]);
      assert.equal(before.active, true);
      precision.push({
        raw,
        truncated,
        rejected_truncated_ack: true,
        view_before_physical_resume: before,
      });
    },
  });
  const hold = await prepared(x);
  const f = await fixture.seedClocks(x.c, hold.s);
  await fixture.release(x.c, hold.o, hold.s);
  await until(
    () => x.runtime.snapshot().operation?.phase === 'resumed',
    'fractional checkpoint real runtime resume',
    40000
  );
  assert.ok(checked);
  assert.deepEqual(x.errors, []);
  assert.deepEqual(
    [...x.engines.values()].map((e) => e.resumes),
    [1, 1, 1]
  );
  const done = await x.snapshot();
  const clocks = await fixture.clockReceipt(x.c, hold.s, f);
  for (const wave of done.resume_waves) {
    assert.ok(Date.parse(wave.resumed_at) >= Date.parse(wave.credited_through_at));
  }
  await writeFile(
    join(evidence, 'microsecond-precision.json'),
    JSON.stringify(
      {
        precision,
        done,
        clocks,
        note: 'Actual SQL rejects truncating a fractional boundary; delayed native delivery and the real runtime produce accepted positive suffix acknowledgments.',
      },
      null,
      2
    )
  );
}
