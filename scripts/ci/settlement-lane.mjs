// One explicit installer admission on the original global settlement lane.
// Session ownership survives the migration's own BEGIN/COMMIT; no source bytes
// or atomic history are changed. Connection closure releases an unknown outcome.
export async function withSettlementLane(client, send) {
  const prior = (await client.query('SHOW statement_timeout')).rows[0].statement_timeout;
  let acquired = false;
  try {
    await client.query("SET statement_timeout='3s'");
    await client.query('SELECT pg_advisory_lock(530090,1)');
    acquired = true;
    await client.query("SELECT set_config('statement_timeout',$1,false)", [prior]);
    return await send();
  } finally {
    if (acquired) {
      // A refused migration may leave its transaction aborted. ROLLBACK is
      // harmless after COMMIT and required before explicit session release.
      await client.query('ROLLBACK');
      const result = await client.query('SELECT pg_advisory_unlock(530090,1) AS released');
      if (result.rows[0].released !== true) throw new Error('settlement lane release not proven');
    }
    await client.query("SELECT set_config('statement_timeout',$1,false)", [prior]);
  }
}
