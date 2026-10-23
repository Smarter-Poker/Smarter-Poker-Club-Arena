import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __setCashRosterForTest,
  __setRosterExemptClubsForTest,
  cashRosterHeldFromTournaments,
  hasCashRoster,
} from './HorsePloRoster.js';

/**
 * THE CASH ROSTER STAYS AT CASH (Dan 2026-10-23). The 35 to 50 roster horses
 * are the only horses that sit at cash, so tournament fills leave them alone
 * and the rest of the fleet fills the events. The Lightning pilot is exempt.
 */
const PILOT = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';

afterEach(() => {
  __setCashRosterForTest(null);
  __setRosterExemptClubsForTest([]);
});

describe('cashRosterHeldFromTournaments', () => {
  it('holds nobody before the roster has been read', () => {
    __setCashRosterForTest(null);
    expect(hasCashRoster()).toBe(false);
    expect(cashRosterHeldFromTournaments('club-a').size).toBe(0);
  });

  it('holds every roster horse back from an ordinary club event', () => {
    __setCashRosterForTest(['h1', 'h2', 'h3']);
    expect(hasCashRoster()).toBe(true);
    expect([...cashRosterHeldFromTournaments('club-a')].sort()).toEqual(['h1', 'h2', 'h3']);
    expect(cashRosterHeldFromTournaments(null).has('h2')).toBe(true);
  });

  it('holds nobody back from an exempt (Lightning pilot) club event', () => {
    __setCashRosterForTest(['h1', 'h2']);
    __setRosterExemptClubsForTest([PILOT]);
    expect(cashRosterHeldFromTournaments(PILOT).size).toBe(0);
    expect(cashRosterHeldFromTournaments('club-a').size).toBe(2);
  });

  it('returns a copy, so a caller adding to it cannot grow the roster', () => {
    __setCashRosterForTest(['h1']);
    cashRosterHeldFromTournaments('club-a').add('intruder');
    expect(cashRosterHeldFromTournaments('club-a').has('intruder')).toBe(false);
  });
});

describe('TournamentRecurringService wires the hold into both fill paths', () => {
  const src = readFileSync('src/services/TournamentRecurringService.ts', 'utf8');

  it('pickFreeHorses treats a roster horse as busy', () => {
    const body = src.slice(src.indexOf('private async pickFreeHorses('));
    const head = body.slice(0, body.indexOf('selectHorseCandidates('));
    expect(head).toContain('for (const id of await this.cashRosterHeldFor(tournamentId)) busy.add(id);');
  });

  it('registerHorses drops a roster horse after letting ticket holders through', () => {
    const body = src.slice(src.indexOf('private async registerHorses('));
    const ticket = body.indexOf('if (ticketHintIds.has(h.id)) return true;');
    const held = body.indexOf('if (rosterHeld.has(h.id)) {');
    expect(body).toContain('const rosterHeld = await this.cashRosterHeldFor(tournamentId);');
    expect(ticket).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(ticket);
  });

  it('an unreadable host club holds nobody back (fails open)', () => {
    const helper = src.slice(src.indexOf('private async cashRosterHeldFor('));
    const end = helper.indexOf('private async clubMemberIdsForTournament(');
    const fn = helper.slice(0, end);
    expect(fn).toContain('if (error) return new Set();');
    expect(fn).toContain('} catch {\n      return new Set();');
  });
});
