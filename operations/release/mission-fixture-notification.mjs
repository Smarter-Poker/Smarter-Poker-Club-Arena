import { createHash } from 'node:crypto';

// This qualifies fixture notification delivery, not the global scheduler/enqueue RPC.
export async function insertMissionFixtureNotification(account, cycleDate, request) {
  if (
    !/^ca-customization-cert-[a-z0-9-]+@example\.invalid$/.test(account.email) ||
    !/^[0-9a-f-]{36}$/.test(account.user_id) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(cycleDate)
  ) {
    throw new Error('FIXTURE_NOTIFICATION_OWNER_REQUIRED');
  }
  const auth = await request(`/auth/v1/admin/users/${account.user_id}`);
  const user = auth?.user ?? auth;
  if (user?.id !== account.user_id || user?.email !== account.email)
    throw new Error('FIXTURE_NOTIFICATION_OWNER_MISMATCH');
  const preferences = await request(
    `/rest/v1/user_notification_preferences?${new URLSearchParams({ select: 'user_id,daily_mission_reminders', user_id: `eq.${account.user_id}`, limit: '2' })}`
  );
  if (
    !Array.isArray(preferences) ||
    preferences.length !== 1 ||
    preferences[0].user_id !== account.user_id
  )
    throw new Error('FIXTURE_NOTIFICATION_PREFERENCE_REQUIRED');
  if (preferences[0].daily_mission_reminders !== true) return 0;
  const hex = createHash('sha256')
    .update(`fixture-reset-notification:v1:${account.user_id}:${cycleDate}`)
    .digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const rows = await request('/rest/v1/notifications?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      id,
      user_id: account.user_id,
      type: 'daily_challenge',
      title: 'Daily Missions Are Live',
      message: 'A Fresh Set Of Poker Missions And Rewards Is Ready In Club Arena.',
      link: '/hub/club-arena/challenges',
      action_url: '/hub/club-arena/challenges',
      read: false,
      is_read: false,
      data: { source: 'club_arena_daily_missions', cycle_date: cycleDate, tier: 'daily' },
    }),
  });
  if (
    !Array.isArray(rows) ||
    rows.length > 1 ||
    (rows.length === 1 && (rows[0].id !== id || rows[0].user_id !== account.user_id))
  )
    throw new Error('FIXTURE_NOTIFICATION_RESULT_REQUIRED');
  return rows.length;
}
