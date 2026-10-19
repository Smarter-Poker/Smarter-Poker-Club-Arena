import { describe, it, expect } from 'vitest';
import {
  clubWelcomeSetupMissing,
  clubWelcomeTemplate,
} from '../../src/services/ClubWelcomeMessageService';
import { getClubArenaNavigation } from '../../src/config/clubArenaNavigation';
const links = (role: string | null, clubId: string | null = 'shark-club', verified = false) =>
  getClubArenaNavigation({ clubId, clubRole: role, canCustomizeWelcome: verified })
    .flatMap((group) => group.items)
    .filter((item) => item.label === 'Custom Messages');
describe('custom welcome message navigation', () => {
  it.each(['owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent'])(
    'gives %s a club-specific hamburger door',
    (role) => {
      expect(links(role)).toHaveLength(1);
      expect(links(role)[0].path).toBe('/clubs/shark-club/welcome-message');
    }
  );
  it('does not advertise creation to players, managers, or unrelated platform staff', () => {
    for (const role of ['player', 'member', 'manager', null]) expect(links(role)).toHaveLength(0);
  });
  it('uses verified own club eligibility outside a selected club', () => {
    expect(links(null, null, true)[0].path).toBe('/welcome-messages');
    expect(links(null, null)).toHaveLength(0);
  });
});

it('places the custom-message setup nudge directly below Messages', () => {
  const groups = getClubArenaNavigation({
    clubId: 'shark-club',
    clubRole: 'owner',
    welcomeSetupRequired: true,
  });
  const items = groups.find((group) =>
    group.items.some((item) => item.label === 'Messages')
  )!.items;
  const index = items.findIndex((item) => item.label === 'Messages');
  expect(items[index + 1].label).toBe('Custom Messages');
  expect(items[index + 1].description).toBe('Finish Setting Up Your Custom Messages');
});

it('keeps the owner nudge until both independent templates are enabled and nonempty', () => {
  const row = {
    club_id: 'club',
    club_name: 'Club',
    role: 'owner',
    content: 'First',
    enabled: true,
    revision: 1,
    owner_content: '',
    owner_enabled: false,
    owner_revision: 0,
  };
  expect(clubWelcomeSetupMissing(row)).toBe(true);
  const ready = { ...row, owner_content: 'Second', owner_enabled: true, owner_revision: 2 };
  expect(clubWelcomeSetupMissing(ready)).toBe(false);
  expect(clubWelcomeTemplate(ready, 'downline').revision).toBe(1);
  expect(clubWelcomeTemplate(ready, 'club_owner')).toEqual({
    content: 'Second',
    enabled: true,
    revision: 2,
  });
  expect(clubWelcomeSetupMissing({ ...row, role: 'agent' })).toBe(false);
});
