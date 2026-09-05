/**
 * The club message greets you once, at the door, and takes no if for an answer
 * only until you give it one.
 *
 * Dan, 2026-09-03: "Club Message should appear as a 'full screen pop up' when
 * you enter the club, not anywhere 'baked into the screen'. [...] leave padding
 * around all edges top and bottom and create an 'X' off the message button. as
 * well as a don't show me this message again. and the only time a new pop up
 * will be displayed is if the club owner, co owner or admin creates a new
 * message."
 *
 * The two ways out are NOT the same promise, and collapsing them was the
 * tempting simplification:
 *
 *   X            closes it now, writes nothing, greets again next visit. That
 *                is what a day's message is for.
 *   Do Not Show  writes the dismissal and stays quiet until staff write a NEW
 *                message, at which point the club has something else to say.
 *
 * An X that silences a club forever is a trap. A greeting with no quick way out
 * is an obstacle. Both are pinned below.
 */
import { readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entry: null as any,
  dismissCalls: [] as string[],
  saveCalls: [] as any[],
  rpc: null as any,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: any) => {
      if (name === 'fn_get_club_entry_message') {
        return Promise.resolve({ data: mocks.entry, error: null });
      }
      if (name === 'fn_dismiss_club_message') {
        mocks.dismissCalls.push(args.p_club_id);
        return Promise.resolve({ data: { ok: true, dismissed_revision: 7 }, error: null });
      }
      if (name === 'fn_set_club_lobby_message') {
        mocks.saveCalls.push(args);
        return Promise.resolve({
          data: { ok: true, lobby_message: args.p_message, revision: 8 },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: () => {} }));

import ClubEntryMessage from '../../src/components/club/ClubEntryMessage';

const read = (p: string) => readFileSync(p, 'utf8');

const SHOWING = {
  ok: true,
  message: 'Tonight At 8, Double Rakeback On Every Nine Handed Table',
  revision: 7,
  should_show: true,
};

const renderGreeting = (canEdit = false) =>
  render(
    <ClubEntryMessage
      clubId="club-1"
      clubName="Deep Stack Society"
      canEdit={canEdit}
      onOpenAnnouncements={() => {}}
      onToast={() => {}}
    />
  );

const click = async (name: RegExp) => {
  const el = screen.getByRole('button', { name });
  await act(async () => el.click());
};

describe('the club message meets you at the door', () => {
  beforeEach(() => {
    mocks.entry = SHOWING;
    mocks.dismissCalls = [];
    mocks.saveCalls = [];
  });

  it('greets on entry when the server says to', async () => {
    renderGreeting();
    expect(await screen.findByText(SHOWING.message)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  /**
   * The whole point of the rewrite. Three lobby elements printed this message
   * with three different editors and three different length caps.
   */
  it('renders nothing at all when the server says not to', async () => {
    mocks.entry = { ...SHOWING, should_show: false };
    renderGreeting();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(SHOWING.message)).toBeNull();
  });

  it('renders nothing when no message has been written', async () => {
    mocks.entry = { ok: true, message: null, revision: 3, should_show: false };
    renderGreeting();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  /** X closes. It must NOT write a dismissal. */
  it('closes on the X without silencing the club', async () => {
    renderGreeting();
    await screen.findByText(SHOWING.message);
    await click(/close club message/i);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.dismissCalls, 'the X must never write a dismissal').toEqual([]);
  });

  /**
   * A tap beside the card is the X by another gesture (Dan, 2026-09-04:
   * "NEVER BLOCKS ENTIRE PAGES"). It closes, and it writes nothing.
   */
  it('closes on a tap beside the card without silencing the club', async () => {
    renderGreeting();
    await screen.findByText(SHOWING.message);
    const overlay = document.querySelector('.modal-overlay') as HTMLElement | null;
    expect(overlay, 'the backdrop must exist').not.toBeNull();
    await act(async () => overlay!.click());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.dismissCalls, 'a backdrop tap must never write a dismissal').toEqual([]);
  });

  /** The other control is the one that writes. */
  it('records the dismissal when asked not to show it again', async () => {
    renderGreeting();
    await screen.findByText(SHOWING.message);
    await click(/do not show me this message again/i);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.dismissCalls).toEqual(['club-1']);
  });

  /**
   * The client never decides this. `should_show` is the server's answer and
   * the only place the revision rule lives, because it has to be the same
   * answer on every device the person owns.
   */
  it('does not re-derive should_show from the message text', () => {
    const src = read('src/components/club/ClubEntryMessage.tsx');
    expect(src).toContain('result.should_show');
    expect(src, 'the revision rule belongs to the server').not.toMatch(/dismissed_revision\s*[<>]/);
  });

  /** Staff write it where it is read. */
  it('offers the editor to staff only', async () => {
    renderGreeting(false);
    await screen.findByText(SHOWING.message);
    expect(screen.queryByRole('button', { name: /edit message/i })).toBeNull();
  });

  /**
   * The page knows club staff; only the server knows the union that oversees
   * this club. When the server says can_manage, the editor is offered even
   * though the page's own role read said no (migration 20260905000730).
   */
  it('offers the editor when the server says this person may manage the message', async () => {
    mocks.entry = { ...SHOWING, can_manage: true };
    renderGreeting(false);
    await screen.findByText(SHOWING.message);
    expect(screen.getByRole('button', { name: /edit message/i })).toBeInTheDocument();
  });

  it('saves a staff edit through the guarded writer', async () => {
    renderGreeting(true);
    await screen.findByText(SHOWING.message);
    await click(/edit message/i);
    await click(/save message/i);
    expect(mocks.saveCalls).toHaveLength(1);
    expect(mocks.saveCalls[0].p_club_id).toBe('club-1');
  });

  /**
   * A failed read must cost the greeting and nothing else. The lobby behind it
   * is the product.
   */
  it('stays silent when the read fails', async () => {
    mocks.entry = { ok: false, reason: 'club_not_found' };
    renderGreeting();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the lobby no longer bakes the message into the page', () => {
  /**
   * Pinned as an ABSENCE across all three surfaces that used to print it.
   * Re-adding any of them is the regression, and no assertion about what the
   * lobby DOES render would catch it.
   */
  it('has no message strip, no rail trigger and no inline editor', () => {
    const page = read('src/pages/ClubHomePage.tsx');
    expect(page).not.toContain('club-mobile-owner-message');
    expect(page).not.toContain('<ClubOwnerMessage');
    expect(page).not.toContain('lobby-top__notice-editor');
    expect(page).not.toContain('CLUB_LOBBY_MESSAGE_MAX_LENGTH');
    expect(page).toContain('<ClubEntryMessage');
  });

  /** Dan asked for padding on every edge, and a phone has four of its own. */
  it('leaves padding on every edge including the phone safe areas', () => {
    const css = read('src/components/club/ClubEntryMessage.css');
    expect(css).toContain('env(safe-area-inset-top)');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('env(safe-area-inset-left)');
    expect(css).toContain('env(safe-area-inset-right)');
  });
});
