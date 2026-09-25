/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PAINTED HEAD READS AS WORDS, NOT AS ONE WORD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #ClubArenaConsole prints a head's eyebrow, title, subtitle and pill into
 * four zones measured off the master art. Every zone is `position: absolute`,
 * so what the eye reads as "TOURNAMENT / LOBBY" on two lines is four DOM
 * siblings with nothing at all between them - and until 2026-09-23 the
 * tournament lobby's panel had a text content of
 *
 *     "TournamentLobbyIn GameClose..."
 *
 * Nobody sees that, which is exactly why it survived: it is what a screen
 * reader, a copy-paste and `tests/e2e/tournament-watch.spec.ts` read, and
 * that spec has been red on main on every post-deploy run
 * (`await expect(lobby).toContainText(/Tournament Lobby/i)`).
 *
 * ZoneText now closes its own text with a space. `.sc-zone` is `display:
 * grid`, and a grid container does not render a child text run that is only
 * white space, so the separator exists where text is read and in no box at
 * all. These tests pin both halves of that: the words are separated, and the
 * visible line is still exactly the label with nothing appended to it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpadeConsole } from '../../src/components/console/SpadeConsole';
import TournamentLobbyModal from '../../src/components/table/TournamentLobbyModal';

/* The lobby page itself is not what this is about, and it is the expensive
   half of the modal. The panel, its console and its head are real. */
vi.mock('../../src/pages/tournament/TournamentDetails', () => ({
  default: () => <div data-testid="lobby-page" />,
}));

describe('a painted console head reads as words', () => {
  it('separates every head zone in the text a reader gets', () => {
    const { container } = render(
      <SpadeConsole eyebrow="Tournament" title="Lobby" pill="In Game" subtitle="Seat 4" />
    );
    const head = container.querySelector('.sc__head');
    expect(head).not.toBeNull();
    expect(head!.textContent).toMatch(/Tournament Lobby/);
    expect(head!.textContent).toMatch(/Lobby Seat 4/);
    expect(head!.textContent).toMatch(/Seat 4 In Game/);
  });

  it('appends nothing to the line that is actually printed in the zone', () => {
    const { container } = render(<SpadeConsole eyebrow="Tournament" title="Lobby" />);
    const printed = [...container.querySelectorAll('.sc-zone > span')].map((s) => s.textContent);
    expect(printed).toEqual(['Tournament', 'Lobby']);
    // The separator is a sibling of the fitted span, never inside it: useFitText
    // measures that span, and a trailing space in it would be measured too.
    expect(container.querySelector('.sc__title > span')!.textContent).toBe('Lobby');
  });

  it('gives the tournament lobby panel the text the watch spec asserts', () => {
    render(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />);
    const panel = document.querySelector('.tlm-panel');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toMatch(/Tournament Lobby/i);
    // And the door out is still named, one word away from the head.
    expect(screen.getAllByRole('button', { name: 'Close' })[0]).toBeInTheDocument();
  });
});
