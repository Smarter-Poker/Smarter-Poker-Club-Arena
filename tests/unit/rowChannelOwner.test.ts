import { describe, expect, it } from 'vitest';
import { isClubMemberOwnerJoin } from '../e2e/support/rowChannelOwner';
const club = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const binding = {
  schema: 'public',
  table: 'club_members',
  event: '*',
  filter: `club_id=eq.${club}`,
};
const payload = (value: unknown = binding) => ({ config: { postgres_changes: [value] } });
describe('per-view club row owner admission', () => {
  it.each([club, 'kings-club'])('admits the exact club binding under route key %s', (key) => {
    expect(
      isClubMemberOwnerJoin(`realtime:club-members-${key}:row:view1`, 'phx_join', payload(), club)
    ).toBe(true);
  });
  it.each([
    { ...binding, filter: 'club_id=eq.some-other-club' },
    { ...binding, filter: undefined },
    { ...binding, table: 'agents' },
    { ...binding, schema: 'private' },
    { ...binding, event: 'INSERT' },
    null,
  ])('refuses unrelated or malformed database scope %j', (value) => {
    expect(
      isClubMemberOwnerJoin(
        'realtime:club-members-kings-club:row:view1',
        'phx_join',
        payload(value),
        club
      )
    ).toBe(false);
  });
  it.each([
    'realtime:club-members-kings-club',
    'realtime:club-members-kings-club:row:',
    'realtime:club-agents-kings-club:row:view1',
    null,
  ])('requires an actual per-view member topic %s', (topic) => {
    expect(isClubMemberOwnerJoin(topic, 'phx_join', payload(), club)).toBe(false);
  });
  it.each([null, {}, { config: null }, { config: { postgres_changes: {} } }])(
    'refuses unreadable join metadata %j',
    (value) => {
      expect(
        isClubMemberOwnerJoin('realtime:club-members-kings-club:row:view1', 'phx_join', value, club)
      ).toBe(false);
    }
  );
  it('does not admit replies or row deliveries as subscriptions', () => {
    expect(
      isClubMemberOwnerJoin(
        'realtime:club-members-kings-club:row:view1',
        'postgres_changes',
        payload(),
        club
      )
    ).toBe(false);
  });
});
