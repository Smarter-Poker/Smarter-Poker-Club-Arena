const commands = new Set(['engine_maintenance_verification_context', 'register_engine_maintenance_need',
  'register_maintenance_safe_resume', 'admit_engine_maintenance', 'authorize_maintenance_step', 'authorize_maintenance_release', 'authorize_maintenance_observation',
  'engine_maintenance_actuator_context','consume_engine_maintenance_step']);
export async function maintenanceCall(client, name, args = []) {
  if (!commands.has(name)) throw new Error('RELEASE_MAINTENANCE_COMMAND_INVALID');
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL synchronous_commit=on');
    const version = (await client.query('SELECT release_ops.schema_version() AS v, release_ops.provider_schema_version() AS p')).rows[0];
    if (version.v !== 1 || version.p !== 1) throw new Error('RELEASE_SCHEMA_VERSION_UNSUPPORTED');
    const result = await client.query(`SELECT release_ops.${name}(${args.map((_, i) => `$${i+1}`).join(',')}) AS v`,args);
    await client.query('COMMIT'); return result.rows[0].v;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
