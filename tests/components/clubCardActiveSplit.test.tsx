import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ClubCardPanel } from '@/components/club/ClubCardPanel';
import { resetLobbyFigureCacheForTests } from '@/lib/lobbyFigureCache';

/**
 * Dan, 2026-09-09: "why are the club lobby tables not displaying the same
 * numbers as how many players are actually playing?! each club shows 300-549
 * active players, but only showing a handful of cash games open and players
 * sitting..."
 *
 * ACTIVE was one figure that mixed cash seats with tournament seats. The card
 * now prints the split under the total - who is at cash tables, who is in
 * events - from the cash_count / event_count columns the counts RPC returns.
 */
function splitText(): string {
  return Array.from(document.querySelectorAll('.club-card-stat-split-part'))
    .map((el) => el.textContent?.trim() ?? '')
    .join(' ');
}

describe('the club card prints active players by game', () => {
  beforeEach(() => {
    resetLobbyFigureCacheForTests();
    cleanup();
  });

  it('shows the total and, under it, cash and events', () => {
    render(
      <ClubCardPanel
        clubName="CLUB JAQK"
        totalMembers={584}
        clubLevel={29}
        activePlayers={291}
        activeCash={21}
        activeEvents={270}
        clubId={77777}
      />
    );
    const active = document.querySelector('.club-card-stat--active .club-card-stat-value');
    expect(active?.textContent).toBe('291');
    expect(splitText()).toBe('21 CASH 270 EVENTS');
  });

  it('opens on zeros, never the word unavailable, until the split lands', () => {
    render(
      <ClubCardPanel
        clubName="SHARK CLUB"
        totalMembers={null}
        clubLevel={null}
        activePlayers={null}
        clubId={25450}
      />
    );
    expect(splitText()).toBe('0 CASH 0 EVENTS');
    expect(document.body.textContent).not.toMatch(/unavailable/i);
  });

  it('remembers the last split it saw for the same club', () => {
    const { unmount } = render(
      <ClubCardPanel
        clubName="DEEP STACK SOCIETY"
        totalMembers={418}
        clubLevel={26}
        activePlayers={353}
        activeCash={119}
        activeEvents={290}
        clubId={11192}
      />
    );
    unmount();
    render(
      <ClubCardPanel
        clubName="DEEP STACK SOCIETY"
        totalMembers={null}
        clubLevel={null}
        activePlayers={null}
        clubId={11192}
      />
    );
    expect(splitText()).toBe('119 CASH 290 EVENTS');
  });
});
