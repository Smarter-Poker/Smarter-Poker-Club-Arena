/**
 * THE IN-GAME TOURNAMENT LOBBY IS A FULL-SCREEN POPUP THAT WORKS ON A PHONE
 * (Dan 2026-10-04).
 *
 * "when you click on the tournament lobby card, nothing work or is functional
 * ... it should be 'full screen pop up' ... (as a note, things seem to
 * 'appear' on desk top, but zero functionality on mobile)."
 *
 * Measured before the change, headless at 375x667 with the real event's rows:
 * the popup was a 75dvh sheet holding a painted console (head, Close row,
 * foot) around a lobby page that drew its own framed header, a two-row framed
 * tab rail and a framed title strip. What was left for the tab panel was
 * 308x52px, with the footer pushed off the sheet. Every tab switched when
 * tapped. Nothing visible changed. After: the panel is 375x397 on the same
 * phone.
 *
 * jsdom has no layout, so the geometry is pinned on the stylesheet and the
 * behaviour on the component.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceCssRule } from '../helpers/sourceWindow';

const lobbyProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../../src/pages/tournament/TournamentDetails', () => ({
  default: (props: Record<string, unknown>) => {
    lobbyProps.last = props;
    return <div data-testid="lobby-page" />;
  },
}));

import TournamentLobbyModal from '../../src/components/table/TournamentLobbyModal';

afterEach(() => {
  cleanup();
  lobbyProps.last = null;
});

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const MODAL_CSS = read('src/components/table/TournamentLobbyModal.css');
const CHASSIS_CSS = read('src/styles/metallic-popups.css');
const PAGE = read('src/pages/tournament/TournamentDetails.tsx');

describe('the popup covers the screen', () => {
  it('is the whole viewport, with dvh after vh so a phone toolbar cannot hide the footer', () => {
    const rule = sliceCssRule(MODAL_CSS, '.tlm-panel--full');
    expect(rule).toMatch(/width:\s*100vw/);
    expect(rule).toMatch(/height:\s*100vh;\s*height:\s*100dvh/);
    expect(rule).toMatch(/border-radius:\s*0/);
  });

  it('does not fall back to the 3/4 sheet on a phone', () => {
    const phone = MODAL_CSS.slice(MODAL_CSS.lastIndexOf('@media (max-width: 640px)'));
    expect(phone).toContain('.tlm-panel--full');
    expect(phone).toMatch(/height:\s*100dvh/);
    expect(phone).not.toMatch(/75dvh/);
  });

  it('leaves the 3/4 sheet in place for the must-move lobby that borrows it', () => {
    expect(sliceCssRule(MODAL_CSS, '.tlm-panel')).toMatch(/width:\s*75vw/);
  });

  it('renders the full-screen shape and no console', () => {
    render(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Tournament Lobby' });
    expect(dialog).toHaveClass('tlm-panel', 'tlm-panel--full');
    expect(dialog.parentElement).toHaveClass('tlm-overlay--full');
    expect(dialog.querySelector('.sc')).toBeNull();
  });
});

describe('the popup hands the page what it needs to be usable', () => {
  it('passes its close handler and the table it is open over', () => {
    const onClose = vi.fn();
    render(
      <TournamentLobbyModal isOpen tournamentId="t-1" currentTableId="tbl-9" onClose={onClose} />
    );
    expect(lobbyProps.last).toMatchObject({
      tournamentIdOverride: 't-1',
      suppressAutoOpenTable: true,
      currentTableId: 'tbl-9',
      onClose,
    });
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a swipe inside the lobby from reaching the table-switch gesture', () => {
    const onTouch = vi.fn();
    render(
      <div onTouchStart={onTouch} onTouchMove={onTouch} onTouchEnd={onTouch}>
        <TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />
      </div>
    );
    const page = screen.getByTestId('lobby-page');
    fireEvent.touchStart(page, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchMove(page, { touches: [{ clientX: 80, clientY: 100 }] });
    fireEvent.touchEnd(page);
    expect(onTouch).not.toHaveBeenCalled();
  });

  it('stays mounted once opened, so a re-open is instant', () => {
    const { rerender } = render(
      <TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />
    );
    rerender(<TournamentLobbyModal isOpen={false} tournamentId="t-1" onClose={() => {}} />);
    expect(screen.getByTestId('lobby-page')).toBeInTheDocument();
    expect(document.querySelector('.tlm-overlay--full')).toHaveStyle({ display: 'none' });
  });
});

describe('the page inside the popup', () => {
  it('draws its Close control in every state, so a loading popup is never a trap', () => {
    const loading = PAGE.slice(
      PAGE.indexOf('if (isLoading) {'),
      PAGE.indexOf('const shortDescription')
    );
    // loading, failed to load, and not found
    expect(loading.match(/\{closeButton\}/g)?.length).toBe(3);
    expect(PAGE).toContain('aria-label="Close Tournament Lobby"');
  });

  it('offers the way back, not a link to the table the player is already at', () => {
    expect(PAGE).toContain('myEntry.table_id === currentTableId');
    expect(PAGE).toContain('Back To Table');
  });
});

describe('the popup chassis leaves a full-page dialog alone', () => {
  it('opts the lobby out, on the dialog element', () => {
    render(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-popup-chassis', 'none');
  });

  it('honours the opt-out on every rule that reaches into a dialog', () => {
    const code = CHASSIS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const reaching = code.match(/\[role='dialog'\][^,{]*,\s*\[aria-modal='true'\]/g) ?? [];
    expect(reaching.length).toBeGreaterThan(0);
    for (const selector of reaching) {
      expect(selector).toContain("[role='dialog']:not([data-popup-chassis='none'])");
    }
    expect(code).not.toMatch(/\[aria-modal='true'\](?!:not\(\[data-popup-chassis='none'\]\))/);
  });
});
