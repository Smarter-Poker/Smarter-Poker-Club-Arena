import { readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';
import { act, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entry: null as any,
  posts: [] as Array<{ id: string; title: string; content: string }>,
  dismissCalls: [] as string[],
  saveCalls: [] as any[],
  rpc: null as any,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: async () => ({ data: mocks.posts, error: null }),
      };
      return q;
    },
    rpc: (name: string, args: any) => {
      const override = mocks.rpc?.(name, args);
      if (override !== undefined) return override;
      if (name === 'fn_claim_club_entry_news') {
        const data = { ...mocks.entry, announcements: mocks.posts };
        mocks.entry = { ...mocks.entry, should_show: false };
        mocks.posts = [];
        return Promise.resolve({ data, error: null });
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
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-1' } }),
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
    localStorage.clear();
    mocks.posts = [];
    mocks.entry = SHOWING;
    mocks.dismissCalls = [];
    mocks.saveCalls = [];
    mocks.rpc = null;
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
  it('does not greet again after revisiting the same club today', async () => {
    const first = renderGreeting();
    await screen.findByText(SHOWING.message);
    first.unmount();
    renderGreeting();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no daily reset or opt-out control', async () => {
    renderGreeting();
    await screen.findByText(SHOWING.message);
    expect(screen.queryByRole('button', { name: /do not show again/i })).toBeNull();
    expect(read('src/components/club/ClubEntryMessage.tsx')).not.toContain('localStorage');
    expect(read('src/components/club/ClubEntryMessage.tsx')).not.toContain(
      'fn_dismiss_club_message'
    );
  });

  it('shows available announcements directly even when there is no greeting', async () => {
    mocks.entry = { ok: true, should_show: false };
    mocks.posts = [{ id: 'post-1', title: 'club update', content: 'new games today' }];
    renderGreeting();
    expect(await screen.findByText('Club Update')).toBeInTheDocument();
    expect(screen.getByText('New Games Today')).toBeInTheDocument();
    expect(screen.queryByText('View Club Announcements')).toBeNull();
    await click(/^close$/i);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

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
    await click(/^close$/i);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.dismissCalls, 'the X must never write a dismissal').toEqual([]);
  });

  it('enters the lobby without a preference write', async () => {
    renderGreeting();
    await screen.findByText(SHOWING.message);
    await click(/enter lobby/i);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.dismissCalls).toEqual([]);
  });

  it('survives StrictMode effect replay', async () => {
    render(
      <StrictMode>
        <ClubEntryMessage
          clubId="club-1"
          clubName="Deep Stack Society"
          canEdit={false}
          onOpenAnnouncements={() => {}}
          onToast={() => {}}
        />
      </StrictMode>
    );
    expect(await screen.findByText(SHOWING.message)).toBeInTheDocument();
  });

  it('shows a new server message on a later entry', async () => {
    const first = renderGreeting();
    await screen.findByText(SHOWING.message);
    first.unmount();
    mocks.entry = { ...SHOWING, message: 'New Club News', revision: 8 };
    renderGreeting();
    expect(await screen.findByText('New Club News')).toBeInTheDocument();
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

  it('saves a staff edit through the guarded writer', async () => {
    renderGreeting(true);
    await screen.findByText(SHOWING.message);
    await click(/edit message/i);
    await click(/save message/i);
    expect(mocks.saveCalls).toHaveLength(1);
    expect(mocks.saveCalls[0].p_club_id).toBe('club-1');
  });

  it('renders the claimed message when another staff edit overtakes a save', async () => {
    renderGreeting(true);
    await screen.findByText(SHOWING.message);
    await click(/edit message/i);
    mocks.rpc = (name: string) =>
      name === 'fn_claim_club_entry_news'
        ? Promise.resolve({
            data: {
              ok: true,
              should_show: true,
              message: 'Newer Staff Update',
              revision: 9,
              announcements: [],
            },
            error: null,
          })
        : undefined;
    await click(/save message/i);
    expect(await screen.findByText('Newer Staff Update')).toBeInTheDocument();
    expect(screen.queryByText(SHOWING.message)).toBeNull();
  });

  it('does not claim or repaint an old club after a delayed staff save', async () => {
    const saved = vi.fn();
    const view = render(
      <ClubEntryMessage
        clubId="club-1"
        clubName="First Club"
        canEdit
        onMessageSaved={saved}
        onOpenAnnouncements={() => {}}
        onToast={() => {}}
      />
    );
    await screen.findByText(SHOWING.message);
    await click(/edit message/i);
    let finish!: (result: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const calls: string[] = [];
    mocks.rpc = (name: string) => {
      calls.push(name);
      return name === 'fn_set_club_lobby_message' ? pending : undefined;
    };
    await click(/save message/i);
    mocks.entry = { ...SHOWING, message: 'Second Club News' };
    view.rerender(
      <ClubEntryMessage
        clubId="club-2"
        clubName="Second Club"
        canEdit
        onMessageSaved={saved}
        onOpenAnnouncements={() => {}}
        onToast={() => {}}
      />
    );
    await screen.findByText('Second Club News');
    const claims = calls.filter((name) => name === 'fn_claim_club_entry_news').length;
    await act(async () =>
      finish({ data: { ok: true, lobby_message: 'Old Club Save', revision: 8 }, error: null })
    );
    expect(screen.getByText('Second Club News')).toBeInTheDocument();
    expect(saved).not.toHaveBeenCalled();
    expect(calls.filter((name) => name === 'fn_claim_club_entry_news')).toHaveLength(claims);
  });

  it('does not claim unseen news after closing an in-flight staff save', async () => {
    renderGreeting(true);
    await screen.findByText(SHOWING.message);
    await click(/edit message/i);
    let finish!: (result: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const claims = vi.fn();
    mocks.rpc = (name: string) => {
      if (name === 'fn_set_club_lobby_message') return pending;
      if (name === 'fn_claim_club_entry_news') claims();
      return undefined;
    };
    await click(/save message/i);
    await click(/^close$/i);
    await act(async () =>
      finish({ data: { ok: true, lobby_message: 'Later News', revision: 8 }, error: null })
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(claims).not.toHaveBeenCalled();
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
