import { describe, expect, it } from 'vitest';
import { parseRateAuditRows } from '../../src/pages/RateAuditPage';

const CLUB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('Rate Audit operator identity presentation', () => {
  it('keeps validated UUIDs internal when the audit relation supplies no display names', () => {
    const commission = parseRateAuditRows(
      [
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          agent_id: AGENT_ID,
          club_id: CLUB_ID,
          changed_by: ACTOR_ID,
          old_rate: 0.1,
          new_rate: 0.12,
          rate_type: 'commission',
          created_at: '2026-10-05T12:00:00.000Z',
        },
      ],
      'commission',
      CLUB_ID
    );
    const rake = parseRateAuditRows(
      [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          club_id: CLUB_ID,
          changed_by: ACTOR_ID,
          old_rate: 0.01,
          new_rate: 0.02,
          rate_type: 'rake_pct',
          created_at: '2026-10-05T12:00:00.000Z',
        },
      ],
      'rake',
      CLUB_ID
    );

    expect(commission[0]).toMatchObject({
      entityId: AGENT_ID,
      entityLabel: 'Agent Name Unavailable',
      changedBy: 'Operator Name Unavailable',
    });
    expect(rake[0]).toMatchObject({
      entityId: CLUB_ID,
      entityLabel: 'Club Name Unavailable',
      changedBy: 'Operator Name Unavailable',
    });
    expect(commission[0].entityLabel).not.toContain(AGENT_ID.slice(0, 8));
    expect(commission[0].changedBy).not.toContain(ACTOR_ID.slice(0, 8));
    expect(rake[0].entityLabel).not.toContain(CLUB_ID.slice(0, 8));
  });
});
