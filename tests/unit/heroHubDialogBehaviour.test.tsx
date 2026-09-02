/**
 * HERO HUB — THE DIALOG BEHAVIOURS IT SHIPPED WITHOUT (2026-08-29).
 *
 * The hub went live as a bare div: Escape did nothing, focus stayed on the
 * felt behind an overlay covering it, closing left focus nowhere, the
 * tablist announced itself as a tablist while behaving like a row of
 * unrelated buttons, and — worst — it sat over the action buttons while the
 * turn timer ran, so reading your own VPIP could cost you the hand.
 *
 * Every beat below is one of those. They are behavioural, not source greps,
 * because all of them are reachable in jsdom.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HeroHubPanel } from '../../src/components/table/HeroHubPanel';

const noop = () => {};
const base = {
  isOpen: true,
  onClose: noop,
  userId: 'user-1',
  emojiEnabled: false, // keeps ThrowableSelector (and its service) out of it
  isTournament: false,
  onThrowableSelect: noop,
  onOpenStats: noop,
  onOpenTournamentInfo: noop,
  onOpenProfileView: noop,
  onOpenAvatarPicker: noop,
  onOpenIdentity: noop,
  onOpenTableSettings: noop,
};

beforeEach(() => {
  sessionStorage.clear();
  cleanup();
});

describe('it is a real dialog', () => {
  it('announces itself as a modal dialog', () => {
    render(<HeroHubPanel {...base} />);
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.getAttribute('aria-label')).toBe('Player Hub');
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(<HeroHubPanel {...base} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('takes focus on open and hands it back on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const view = render(<HeroHubPanel {...base} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('the tablist follows the WAI-ARIA tab pattern', () => {
  it('each tab controls a panel that is actually labelled by it', () => {
    render(<HeroHubPanel {...base} />);
    const selected = screen
      .getAllByRole('tab')
      .find((t) => t.getAttribute('aria-selected') === 'true')!;
    const panelId = selected.getAttribute('aria-controls')!;
    const panel = document.getElementById(panelId)!;
    expect(panel, `tab ${selected.textContent} controls nothing`).toBeTruthy();
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.getAttribute('id'));
  });

  it('is one tab stop — roving tabindex, not four', () => {
    render(<HeroHubPanel {...base} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '-1')).toHaveLength(tabs.length - 1);
  });

  it('arrow keys move between tabs, Home/End jump to the ends', () => {
    render(<HeroHubPanel {...base} />);
    const list = screen.getByRole('tablist');
    const sel = () =>
      screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!
        .textContent;

    expect(sel()).toBe('Throwables');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(sel()).toBe('Stats');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(sel()).toBe('Throwables');
    fireEvent.keyDown(list, { key: 'End' });
    expect(sel()).toBe('Table');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(sel()).toBe('Throwables');
  });
});

/*
 * REPLACES 'A MENU MUST NEVER TIME OUT A HAND' (Dan 2026-08-31, binding).
 *
 * That block pinned the opposite rule: the hub called onClose() as soon as the
 * turn arrived, so it could not cover the action buttons. Dan: "IT SHOULD
 * NEVER AUTO CLOSE." The hazard it guarded against (a covered Fold button) is
 * now answered in CSS - the overlay yields instead of closing - so the
 * assertion moved to the new mechanism rather than being deleted.
 */
describe('NOTHING THE PLAYER OPENED EVER CLOSES ITSELF', () => {
  it('stays open when the turn arrives, and yields the felt instead', () => {
    const onClose = vi.fn();
    const view = render(<HeroHubPanel {...base} onClose={onClose} isHeroTurn={false} />);
    const overlay = () => view.baseElement.querySelector('.hero-hub__overlay');

    expect(overlay()).toBeTruthy();
    expect(overlay()?.className).not.toContain('hero-hub__overlay--yield');

    view.rerender(<HeroHubPanel {...base} onClose={onClose} isHeroTurn={true} />);

    expect(
      onClose,
      'the hub closed itself when the turn arrived - it must never auto close'
    ).not.toHaveBeenCalled();
    expect(overlay(), 'the hub unmounted when the turn arrived').toBeTruthy();
    expect(
      overlay()?.className,
      'the hub stayed open but did not yield, so it still covers the action bar'
    ).toContain('hero-hub__overlay--yield');
  });

  it('does not yield or close while the turn is not the hero seat', () => {
    const onClose = vi.fn();
    const view = render(<HeroHubPanel {...base} onClose={onClose} isHeroTurn={false} />);
    expect(onClose).not.toHaveBeenCalled();
    expect(view.baseElement.querySelector('.hero-hub__overlay')?.className).not.toContain(
      'hero-hub__overlay--yield'
    );
  });
});

describe('the hub says whose it is, and shows the figures inline', () => {
  const stats = {
    stack: 1234.5,
    profitLoss: -12.25,
    handsPlayed: 42,
    vpipPercent: 27,
    pfrPercent: 19,
    bigBlindsWon: -6.1,
  };

  it('renders the identity header', () => {
    render(<HeroHubPanel {...base} heroName="kingfish" stats={stats} />);
    expect(screen.getByText('kingfish')).toBeTruthy();
  });

  it('shows real figures on the Stats tab instead of only a launcher', () => {
    render(<HeroHubPanel {...base} heroName="kingfish" stats={stats} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Stats' }));
    for (const label of ['Stack', 'Session', 'Hands', 'VPIP', 'PFR']) {
      expect(screen.getByText(label), `figure ${label} missing`).toBeTruthy();
    }
    // House rule 5: formatted, not hand-padded. And the deep panel survives.
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Full Session Stats')).toBeTruthy();
  });

  it('prints "-" for a figure we do not have — never a fabricated zero', () => {
    render(
      <HeroHubPanel
        {...base}
        heroName="kingfish"
        stats={{
          stack: null,
          profitLoss: null,
          handsPlayed: null,
          vpipPercent: null,
          pfrPercent: null,
          bigBlindsWon: null,
        }}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Stats' }));
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('hides cash-only figures on a tournament', () => {
    render(<HeroHubPanel {...base} isTournament heroName="kingfish" stats={stats} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Stats' }));
    expect(screen.queryByText('Session')).toBeNull();
    expect(screen.queryByText('BB Won')).toBeNull();
    expect(screen.getByText('Stack')).toBeTruthy();
    expect(screen.getByText('Tournament Info')).toBeTruthy();
  });
});
