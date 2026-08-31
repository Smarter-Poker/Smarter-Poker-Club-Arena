import { describe, expect, it } from 'vitest';

import { isDailyMissionRevisionFrame } from '../e2e/support/dailyMissionRevisionFrame';

const table = 'daily_challenge_dashboard_revisions';

describe('Daily Missions revision websocket frame detection', () => {
  it.each([
    JSON.stringify({ event: 'postgres_changes', payload: { data: { table } } }),
    JSON.stringify([null, '2', 'topic', 'postgres_changes', { data: { table } }]),
    JSON.stringify([
      null,
      '2',
      'topic',
      'broadcast',
      { event: 'postgres_changes', payload: { data: { table } }, type: 'broadcast' },
    ]),
    Buffer.from(
      JSON.stringify({
        event: 'broadcast',
        payload: { event: 'postgres_changes', payload: { schema: 'public', table } },
      })
    ),
  ])('recognizes direct and nested Supabase change frames', (frame) => {
    expect(isDailyMissionRevisionFrame(frame)).toBe(true);
  });

  it('does not mistake a Phoenix join acknowledgement for a change event', () => {
    const joinReply = JSON.stringify([
      null,
      '1',
      'realtime:public',
      'phx_reply',
      { response: { postgres_changes: [{ id: 7, table }] }, status: 'ok' },
    ]);
    expect(isDailyMissionRevisionFrame(joinReply)).toBe(false);
  });

  it.each([
    'not-json',
    JSON.stringify({ event: 'postgres_changes', payload: { data: { table: 'profiles' } } }),
    JSON.stringify({ event: 'broadcast', payload: { data: { table } } }),
  ])('ignores malformed and unrelated frames', (frame) => {
    expect(isDailyMissionRevisionFrame(frame)).toBe(false);
  });
});
