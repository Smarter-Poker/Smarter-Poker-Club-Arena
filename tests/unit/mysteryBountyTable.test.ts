/**
 * THE TABLE'S VIEW OF A MYSTERY BOUNTY EVENT (2026-10-05).
 *
 * Three defects from the mystery bounty audit, pinned on the pure rules in
 * src/utils/mysteryBountyTable.ts and on TablePage's wiring of them:
 *
 *   - the table was never told the chests had gone live;
 *   - every seat kept advertising the flat head through the chest phase;
 *   - the bounty badges hung off a postgres_changes listener on a table that
 *     is not in the realtime publication, so it never fired.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MYSTERY_BOUNTIES_LIVE_TEXT,
  claimMysteryLiveAnnouncement,
  mysteryChestsLiveFromRow,
  seatBountyBadge,
  seatedPlayersSignature,
} from '../../src/utils/mysteryBountyTable';
import { formatPopupText } from '../../src/utils/popupStyle';

const tablePage = readFileSync(join(process.cwd(), 'src/pages/TablePage.tsx'), 'utf8');

describe('the chests going live is announced at the table', () => {
  it('announces once per event per table', () => {
    const seen = new Set<string>();
    expect(claimMysteryLiveAnnouncement(seen, 't-1')).toBe(true);
    expect(claimMysteryLiveAnnouncement(seen, 't-1')).toBe(false);
    expect(claimMysteryLiveAnnouncement(seen, 't-2')).toBe(true);
    expect(claimMysteryLiveAnnouncement(seen, '')).toBe(false);
    expect(claimMysteryLiveAnnouncement(seen, null)).toBe(false);
  });

  it('the popup text is already Title Case with no em dash', () => {
    expect(formatPopupText(MYSTERY_BOUNTIES_LIVE_TEXT)).toBe(MYSTERY_BOUNTIES_LIVE_TEXT);
    expect(MYSTERY_BOUNTIES_LIVE_TEXT).not.toMatch(/—/);
  });

  it('TablePage handles mystery_bounty_activated through the Toast layer', () => {
    const at = tablePage.indexOf("data?.type === 'mystery_bounty_activated'");
    expect(at).toBeGreaterThan(-1);
    const branch = tablePage.slice(at, at + 900);
    expect(branch).toContain('setMysteryChestsLive(true)');
    expect(branch).toContain('claimMysteryLiveAnnouncement(mysteryLiveAnnouncedRef.current');
    expect(branch).toContain('toast.info(MYSTERY_BOUNTIES_LIVE_TEXT');
  });
});

describe('a seat does not advertise a flat head once the chests are live', () => {
  const bountyMap = { a: 8, b: 12 };

  it('shows the head before the chests open', () => {
    expect(
      seatBountyBadge({
        isBountyTournament: true,
        mysteryChestsLive: false,
        playerId: 'a',
        bountyMap,
      })
    ).toEqual({ value: 8, mystery: false });
  });

  it('shows the mystery prize, not the stale head, once they open', () => {
    expect(
      seatBountyBadge({
        isBountyTournament: true,
        mysteryChestsLive: true,
        playerId: 'a',
        playerStatus: 'active',
        bountyMap,
      })
    ).toEqual({ value: undefined, mystery: true });
  });

  it('hangs no prize on an eliminated player, and none off a bounty event', () => {
    expect(
      seatBountyBadge({
        isBountyTournament: true,
        mysteryChestsLive: true,
        playerId: 'a',
        playerStatus: 'eliminated',
        bountyMap,
      })
    ).toEqual({ value: undefined, mystery: false });
    expect(
      seatBountyBadge({
        isBountyTournament: false,
        mysteryChestsLive: true,
        playerId: 'a',
        bountyMap,
      })
    ).toEqual({ value: undefined, mystery: false });
  });

  it('reads the phase from the tournament row', () => {
    expect(
      mysteryChestsLiveFromRow({ is_mystery_bounty: true, mystery_bounty_stage: 'active' })
    ).toBe(true);
    expect(
      mysteryChestsLiveFromRow({ is_mystery_bounty: true, mystery_bounty_stage: 'pending' })
    ).toBe(false);
    expect(
      mysteryChestsLiveFromRow({ is_mystery_bounty: false, mystery_bounty_stage: 'active' })
    ).toBe(false);
    expect(mysteryChestsLiveFromRow(null)).toBe(false);
  });

  it('TablePage passes the phase to every seat and reads it on load', () => {
    expect(tablePage).toContain('bountyIsMystery={');
    expect(tablePage).toContain('mystery_bounty_stage');
    expect(tablePage).toContain('setMysteryChestsLive(mysteryChestsLiveFromRow(tournData))');
  });
});

describe('the bounty badges follow the seats, not a listener that never fires', () => {
  it('the seat signature changes exactly when the set of seated players does', () => {
    const a = seatedPlayersSignature([{ id: 'x' }, null, { id: 'y' }]);
    expect(seatedPlayersSignature([{ id: 'y' }, { id: 'x' }])).toBe(a);
    expect(seatedPlayersSignature([{ id: 'y' }, { id: 'x' }, { id: 'z' }])).not.toBe(a);
    expect(seatedPlayersSignature([])).toBe('');
    expect(seatedPlayersSignature(undefined)).toBe('');
  });

  it('TablePage has no postgres_changes listener on tournament_players', () => {
    expect(tablePage).not.toMatch(
      /'postgres_changes',\s*\{\s*event:\s*'UPDATE',\s*schema:\s*'public',\s*table:\s*'tournament_players'/
    );
    expect(tablePage).not.toContain('`bounty-${table.tournament_id}`');
  });

  it('TablePage re-reads the heads when the seated players change', () => {
    expect(tablePage).toContain('bountyMapRefreshRef.current = refreshBountyMap');
    expect(tablePage).toContain('seatedPlayersSignature(tableState.players)');
    expect(tablePage).toContain('void bountyMapRefreshRef.current?.()');
  });
});
