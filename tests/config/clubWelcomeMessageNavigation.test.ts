import { describe, it, expect } from 'vitest';
import { getClubArenaNavigation } from '../../src/config/clubArenaNavigation';
const links = (role: string | null, clubId: string | null = 'shark-club', verified = false) =>
  getClubArenaNavigation({ clubId, clubRole: role, canCustomizeWelcome: verified })
    .flatMap((group) => group.items)
    .filter((item) => item.label === 'Custom Welcome Message');
describe('custom welcome message navigation', () => {
  it.each(['owner', 'co_owner', 'super_agent', 'agent', 'sub_agent'])(
    'gives %s a club-specific hamburger door',
    (role) => {
      expect(links(role)).toHaveLength(1);
      expect(links(role)[0].path).toBe('/clubs/shark-club/welcome-message');
    }
  );
  it('does not advertise creation to players, managers, or unrelated platform staff', () => {
    for (const role of ['player', 'member', 'manager', 'admin', null])
      expect(links(role)).toHaveLength(0);
  });
  it('uses verified own club eligibility outside a selected club', () => {
    expect(links(null, null, true)[0].path).toBe('/welcome-messages');
    expect(links(null, null)).toHaveLength(0);
  });
});
