import { describe, it, expect } from 'vitest';
import {
  clubWelcomeSetupMissing,
  clubWelcomeTemplate,
  welcomeNudgeAlreadyShown,
  markWelcomeNudgeShown,
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

it('ends the setup nudge as soon as the user has saved any custom message', () => {
  const row = {
    club_id: 'club',
    club_name: 'Club',
    role: 'owner',
    content: '',
    enabled: false,
    revision: 0,
    owner_content: '',
    owner_enabled: false,
    owner_revision: 0,
  };
  expect(clubWelcomeSetupMissing(row)).toBe(true);
  // Saved only the downline message: done.
  const savedDownline = { ...row, content: 'Hi', enabled: true, revision: 1 };
  expect(clubWelcomeSetupMissing(savedDownline)).toBe(false);
  // Saved only the owner message: done.
  const savedOwner = { ...row, owner_content: 'Hi', owner_enabled: true, owner_revision: 1 };
  expect(clubWelcomeSetupMissing(savedOwner)).toBe(false);
  // Deliberately saved as disabled: that is a decision, not missing setup.
  expect(clubWelcomeSetupMissing({ ...row, revision: 3 })).toBe(false);
  // Agents never saved: still offered once.
  expect(clubWelcomeSetupMissing({ ...row, role: 'agent' })).toBe(true);
  expect(clubWelcomeSetupMissing({ ...row, role: 'agent', revision: 1 })).toBe(false);
  const ready = {
    ...row,
    content: 'First',
    enabled: true,
    revision: 1,
    owner_content: 'Second',
    owner_enabled: true,
    owner_revision: 2,
  };
  expect(clubWelcomeTemplate(ready, 'downline').revision).toBe(1);
  expect(clubWelcomeTemplate(ready, 'club_owner')).toEqual({
    content: 'Second',
    enabled: true,
    revision: 2,
  });
});

it('remembers the setup toast across page loads so it shows at most once per club', () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  expect(welcomeNudgeAlreadyShown('user-1', 'club-a')).toBe(false);
  markWelcomeNudgeShown('user-1', 'club-a');
  expect(welcomeNudgeAlreadyShown('user-1', 'club-a')).toBe(true);
  expect(welcomeNudgeAlreadyShown('user-1', 'club-b')).toBe(false);
  expect(welcomeNudgeAlreadyShown('user-2', 'club-a')).toBe(false);
});
