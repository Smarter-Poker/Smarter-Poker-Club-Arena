import { createHash } from 'node:crypto';

export function missionFixtureHandId(userId) {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('FIXTURE_OWNER_REQUIRED');
  const hex = createHash('sha256')
    .update(`daily-missions-certification-hand:v1:${userId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function cleanupMissionFixtureHand(account, request, creationResolved = false) {
  const id = missionFixtureHandId(account.user_id);
  const query = new URLSearchParams({
    select: 'id,table_id,tournament_id,has_human,players,actions,daily_mission_events',
    id: `eq.${id}`,
    limit: '2',
  });
  const rows = await request(`/rest/v1/hand_history?${query}`);
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('FIXTURE_HAND_READBACK_REQUIRED');
  if (rows.length) {
    const row = rows[0];
    if (
      row.id !== id ||
      row.table_id !== null ||
      row.tournament_id !== null ||
      row.has_human !== false ||
      JSON.stringify(row.players) !== '[]' ||
      JSON.stringify(row.actions) !== '[]' ||
      !Array.isArray(row.daily_mission_events) ||
      row.daily_mission_events.length !== 1 ||
      row.daily_mission_events[0].user_id !== account.user_id
    )
      throw new Error('FIXTURE_HAND_OWNERSHIP_MISMATCH');
    const auth = await request(`/auth/v1/admin/users/${account.user_id}`);
    const user = auth?.user ?? auth;
    if (
      user?.id !== account.user_id ||
      user?.email !== account.email ||
      !/^ca-customization-cert-[a-z0-9-]+@example\.invalid$/.test(account.email)
    )
      throw new Error('FIXTURE_HAND_ACCOUNT_MARKER_REQUIRED');
    // Conditional delete binds every checked ownership field; a concurrent edit cannot widen it.
    const exact = new URLSearchParams({
      id: `eq.${id}`,
      table_id: 'is.null',
      tournament_id: 'is.null',
      has_human: 'eq.false',
      players: 'eq.[]',
      actions: 'eq.[]',
      daily_mission_events: `eq.${JSON.stringify(row.daily_mission_events)}`,
    });
    await request(`/rest/v1/hand_history?${exact}`, { method: 'DELETE' });
    const after = await request(`/rest/v1/hand_history?${query}`);
    if (!Array.isArray(after) || after.length !== 0)
      throw new Error('FIXTURE_HAND_ABSENCE_REQUIRED');
  }
  if (!rows.length && !creationResolved) throw new Error('FIXTURE_HAND_CREATE_UNRESOLVED');
  return { id, absent: true };
}
