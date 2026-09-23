/**
 * Create A Club, Phase 2 hardening (2026-09-20, re-based 2026-09-22 onto the
 * #4696 console render that main shipped in the meantime).
 *
 * Each block pins one repaired behavior and fails against the code it replaced:
 *   - Tab has to reach the painted Close / Create Club plates (the trap once
 *     wrapped only the scroll body; #4696 moved it, and these keep it there);
 *   - the plates never scroll: the console's own body is the scroll region,
 *     and the console narrows by height so short screens keep a body;
 *   - the unsaved-changes guard was window.confirm; it is the kit's
 *     ConfirmModal now;
 *   - the draft key was not scoped to an account;
 *   - the success toast named the text box, not the club the server returned;
 *   - Launch Settings are switches that say On or Off, and the agreement shows
 *     the kit's tick well;
 *   - Club Discovery invented a description and a game tag.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sliceCssRule } from './helpers/sourceWindow';

const state = vi.hoisted(() => ({
  user: { id: 'user-a' } as { id: string } | null,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  create: vi.fn(),
  checkNameAvailability: vi.fn(),
  getCreationEligibility: vi.fn(),
  search: vi.fn(),
  clubRows: [] as Record<string, unknown>[],
}));

vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/services/ClubEntryTrustService', () => ({
  ClubEntryTrustService: { track: vi.fn() },
}));
vi.mock('../src/services/ClubsService', () => ({
  ClubsService: {
    create: state.create,
    checkNameAvailability: state.checkNameAvailability,
    getCreationEligibility: state.getCreationEligibility,
    search: state.search,
  },
}));
vi.mock('../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscription: vi.fn() }));
vi.mock('../src/lib/supabase', () => {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'limit', 'order']) query[method] = () => query;
  query.then = (onFulfilled: (value: { data: unknown; error: null }) => unknown) =>
    Promise.resolve({ data: state.clubRows, error: null }).then(onFulfilled);
  return { supabase: { from: () => query } };
});

import CreateClubModal from '../src/components/modals/CreateClubModal';
import { ClubDiscovery } from '../src/components/clubs/ClubDiscovery';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const modalSource = read('src/components/modals/CreateClubModal.tsx');
const modalCss = read('src/components/modals/CreateClubModal.module.css');
const discoverySource = read('src/components/clubs/ClubDiscovery.tsx');

const DRAFT_PREFIX = 'club-arena:create-draft:v1';

beforeEach(() => {
  window.localStorage.clear();
  state.user = { id: 'user-a' };
  state.clubRows = [];
  for (const spy of Object.values(state.toast)) spy.mockReset();
  state.create.mockReset();
  state.search.mockReset();
  state.checkNameAvailability.mockReset().mockResolvedValue(true);
  state.getCreationEligibility
    .mockReset()
    .mockResolvedValue({ canCreate: true, membershipCount: 1, maxClubs: 4, remaining: 3 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function makeCreatable(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByLabelText('Club Name'), name);
  await screen.findByText('Name Available', undefined, { timeout: 3000 });
  await user.click(screen.getByRole('checkbox', { name: /I Confirm I Can Manage This Club/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create Club' })).toBeEnabled());
}

const guardDialog = () => screen.queryByRole('dialog', { name: 'Close Create Club?' });

describe('the focus trap holds the whole console, plates included', () => {
  it('tabs forward from the last form field onto the painted plates, then wraps', async () => {
    const user = userEvent.setup();
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    await makeCreatable(user, 'Alpha Room');

    const terms = screen.getByRole('checkbox', { name: /I Confirm I Can Manage This Club/ });
    terms.focus();
    await user.tab();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    expect(close.classList.contains('sc-plate')).toBe(true);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create Club' }));

    // The last plate wraps to the first field; focus never leaves the dialog.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Club Name'));
  });

  it('shift-tabs from the first field back onto a plate', async () => {
    const user = userEvent.setup();
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    await screen.findByText('3 Club Slots Remaining');

    screen.getByLabelText('Club Name').focus();
    await user.tab({ shift: true });
    // Create Club is disabled on a pristine form, so the last stop is Close.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(
      screen.getByRole('dialog', { name: 'Create A Club' }).contains(document.activeElement)
    ).toBe(true);
  });

  it('keeps the invisible file input out of the tab order', () => {
    // #4696 takes it out with display: none (Upload A Custom Logo is its
    // keyboard route), which no browser can tab to.
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    expect(modalSource).toMatch(/type="file"[\s\S]{0,120}className=\{styles\.hiddenInput\}/);
    expect(sliceCssRule(modalCss, '.hiddenInput')).toMatch(/display:\s*none/);
  });
});

describe('the painted foot never scrolls', () => {
  it('scrolls the console body between the head and the plates', () => {
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Create A Club' });
    const consoleEl = dialog.querySelector('.sc') as HTMLElement;
    const part = (name: string) =>
      Array.from(consoleEl.children).find((child) => child.classList.contains(name)) as HTMLElement;
    const body = part('sc__body');
    const foot = part('sc__foot');
    const scroller = dialog.querySelector('[class*="scrollBody"]') as HTMLElement;

    expect(scroller).not.toBeNull();
    // The scroll region is the console's own body...
    expect(scroller.parentElement).toBe(body);
    expect(scroller.contains(screen.getByLabelText('Club Name'))).toBe(true);
    // ...and both plates live in the painted foot, outside it.
    expect(scroller.contains(foot)).toBe(false);
    expect(within(foot).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(foot).getByRole('button', { name: 'Create Club' })).toBeInTheDocument();
  });

  it('gives the console the stage height and lets only the scroll body scroll', () => {
    expect(sliceCssRule(modalCss, '.scrollBody')).toMatch(/overflow-y:\s*auto/);
    expect(sliceCssRule(modalCss, '.scrollBody')).toMatch(/min-height:\s*0/);
    expect(sliceCssRule(modalCss, '.console > :global(.sc__body)')).toMatch(/flex:\s*1 1 auto/);
    expect(sliceCssRule(modalCss, '.stage')).toMatch(/overflow:\s*hidden/);
    expect(sliceCssRule(modalCss, '.stage')).toMatch(/align-items:\s*stretch/);
  });
});

describe('the unsaved-changes guard is the kit confirm, not a native dialog', () => {
  it('never calls window.confirm', () => {
    expect(modalSource).not.toMatch(/window\.confirm|\bconfirm\(/);
    expect(modalSource).toContain("import { ConfirmModal } from '../common/ConfirmModal';");
  });

  it('guards Escape, keeps the page on Keep Editing, and closes on Close Now', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    // happy-dom ships no native confirm, so one is planted to prove it is never asked.
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    render(<CreateClubModal isOpen onClose={onClose} />);

    await user.type(screen.getByLabelText('Club Name'), 'Alpha Room');
    await user.keyboard('{Escape}');

    const guard = guardDialog() as HTMLElement;
    expect(guard).toBeVisible();
    expect(guard.textContent).toContain('Stay Saved As A Draft On This Device');
    expect(guard.querySelectorAll('.sc__foot .sc-plate')).toHaveLength(2);
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The safe answer takes focus, so Enter never closes by accident.
    const keepEditing = within(guard).getByRole('button', { name: 'Keep Editing' });
    await waitFor(() => expect(document.activeElement).toBe(keepEditing));

    // Escape answers the guard the way it answered the native dialog: cancel.
    await user.keyboard('{Escape}');
    expect(guardDialog()).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Club Name')).toHaveValue('Alpha Room');

    // A tap on the guard's backdrop cancels too, and never asks again.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(document.querySelector('.confirm-modal-overlay') as HTMLElement);
    expect(guardDialog()).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(
      within(guardDialog() as HTMLElement).getByRole('button', { name: 'Close Now' })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(guardDialog()).not.toBeInTheDocument();
  });

  it('holds the focus trap on the guard while it is up', async () => {
    const user = userEvent.setup();
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Club Name'), 'Alpha Room');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    const guard = guardDialog() as HTMLElement;
    const keepEditing = within(guard).getByRole('button', { name: 'Keep Editing' });
    await waitFor(() => expect(document.activeElement).toBe(keepEditing));

    // Wherever Tab goes, it stays inside the guard's two plates.
    for (const shift of [false, false, true]) {
      await user.tab({ shift });
      expect(guard.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes a pristine form at once, with no guard', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CreateClubModal isOpen onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(guardDialog()).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses to close or raise the guard while a create is in flight', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let settle: (club: { id: string; name: string }) => void = () => undefined;
    state.create.mockReturnValue(
      new Promise((resolvePromise) => {
        settle = resolvePromise;
      })
    );
    render(<CreateClubModal isOpen onClose={onClose} />);
    await makeCreatable(user, 'Alpha Room');
    await user.click(screen.getByRole('button', { name: 'Create Club' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled());
    await user.keyboard('{Escape}');
    expect(guardDialog()).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledTimes(1);

    settle({ id: 'club-1', name: 'Alpha Room' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('a draft belongs to one account', () => {
  it('keeps the pinned literal as the key prefix', () => {
    expect(modalSource).toContain(`const CREATE_DRAFT_KEY = '${DRAFT_PREFIX}';`);
    expect(modalSource).toContain('`${CREATE_DRAFT_KEY}:${userId}`');
  });

  it('ignores and removes the legacy unscoped draft', async () => {
    window.localStorage.setItem(
      DRAFT_PREFIX,
      JSON.stringify({
        name: 'Legacy Room',
        description: 'Somebody Else',
        requestId: '11111111-1111-4111-8111-111111111111',
      })
    );
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    await screen.findByText('3 Club Slots Remaining');
    expect(screen.getByLabelText('Club Name')).toHaveValue('');
    expect(screen.queryByText('Draft Restored')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DRAFT_PREFIX)).toBeNull();
  });

  it('never hands one account the draft, or the request id, of another', async () => {
    const user = userEvent.setup();
    const view = render(<CreateClubModal isOpen onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Club Name'), 'Alpha Room');

    const savedA = JSON.parse(window.localStorage.getItem(`${DRAFT_PREFIX}:user-a`) || 'null');
    expect(savedA?.name).toBe('Alpha Room');
    expect(window.localStorage.getItem(DRAFT_PREFIX)).toBeNull();

    // Same browser, same mounted page, a second account signs in.
    view.rerender(<CreateClubModal isOpen={false} onClose={vi.fn()} />);
    state.user = { id: 'user-b' };
    view.rerender(<CreateClubModal isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText('Club Name')).toHaveValue(''));
    expect(screen.queryByText('Draft Restored')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(`${DRAFT_PREFIX}:user-b`)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(`${DRAFT_PREFIX}:user-a`) || 'null')?.name).toBe(
      'Alpha Room'
    );

    state.create.mockResolvedValue({ id: 'club-b', name: 'Bravo Room' });
    await makeCreatable(user, 'Bravo Room');
    await user.click(screen.getByRole('button', { name: 'Create Club' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0][0].request_id).not.toBe(savedA.requestId);
  });

  it('restores the same account its own draft and request id', async () => {
    const requestId = '22222222-2222-4222-8222-222222222222';
    window.localStorage.setItem(
      `${DRAFT_PREFIX}:user-a`,
      JSON.stringify({ name: 'Alpha Room', description: '', requestId })
    );
    const user = userEvent.setup();
    state.create.mockResolvedValue({ id: 'club-a', name: 'Alpha Room' });
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Club Name')).toHaveValue('Alpha Room'));
    expect(screen.getByText('Draft Restored')).toBeVisible();

    await screen.findByText('Name Available', undefined, { timeout: 3000 });
    await user.click(screen.getByRole('checkbox', { name: /I Confirm I Can Manage This Club/ }));
    await user.click(screen.getByRole('button', { name: 'Create Club' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0][0].request_id).toBe(requestId);
    await waitFor(() => expect(window.localStorage.getItem(`${DRAFT_PREFIX}:user-a`)).toBeNull());
  });
});

describe('the server names the club that was created', () => {
  it('prints the returned name, not the text box, after a renamed retry', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    state.create.mockResolvedValue({ id: 'club-original', name: 'Original Room' });
    render(<CreateClubModal isOpen onClose={vi.fn()} onSuccess={onSuccess} />);
    await makeCreatable(user, 'Renamed Room');
    await user.click(screen.getByRole('button', { name: 'Create Club' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('club-original'));
    expect(state.toast.success).toHaveBeenCalledWith('Club "Original Room" created successfully!');
    expect(
      state.toast.success.mock.calls.some(([message]) => String(message).includes('Renamed Room'))
    ).toBe(false);
  });
});

describe('Launch Settings are switches that say On or Off', () => {
  it('prints On or Off and carries the choice into the create call', async () => {
    const user = userEvent.setup();
    state.create.mockResolvedValue({ id: 'club-1', name: 'Alpha Room' });
    render(<CreateClubModal isOpen onClose={vi.fn()} />);

    const discoverable = screen.getByRole('switch', { name: 'Discoverable In Club Arena' });
    const review = screen.getByRole('switch', { name: 'Review Join Requests' });
    expect(discoverable).toBeChecked();
    expect(review).not.toBeChecked();
    expect(discoverable).toHaveTextContent(/On$/);
    expect(review).toHaveTextContent(/Off$/);

    await user.click(discoverable);
    await user.click(review);
    expect(discoverable).not.toBeChecked();
    expect(review).toBeChecked();
    expect(discoverable).toHaveTextContent(/Off$/);
    expect(review).toHaveTextContent(/On$/);

    await makeCreatable(user, 'Alpha Room');
    await user.click(screen.getByRole('button', { name: 'Create Club' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0][0]).toMatchObject({
      is_public: false,
      requires_approval: true,
    });
  });

  it('shows the agreement as the kit tick well, and keeps no bare checkbox', async () => {
    const user = userEvent.setup();
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    const agreement = screen.getByRole('checkbox', { name: /I Confirm I Can Manage This Club/ });
    expect(agreement.classList.contains('sc-check')).toBe(true);
    expect(agreement.querySelector('.sc-check__box')).not.toBeNull();
    expect(agreement.classList.contains('sc-check--on')).toBe(false);
    await user.click(agreement);
    expect(agreement).toBeChecked();
    expect(agreement.classList.contains('sc-check--on')).toBe(true);
    // No native tick box is left for a setting or for the agreement.
    expect(modalSource).not.toContain('type="checkbox"');
  });
});

describe('the console fits short and notched viewports', () => {
  it('narrows the console by height and never raises the ceiling', () => {
    const rule = sliceCssRule(modalCss, '.console.console');
    expect(rule).toMatch(
      /--sc-max:\s*min\(\s*560px,\s*max\(\s*340px,\s*calc\(\(100cqh - 220px\) \* 1\.6\)\)\)/
    );
    expect(rule).toMatch(/max-width:\s*var\(--sc-max\)/);
    expect(sliceCssRule(modalCss, '.stage')).toMatch(/container-type:\s*size/);
    // Nothing in the sheet may raise the console past the master's 1000px.
    expect(modalCss).not.toMatch(/--sc-max:\s*(?:1[0-9]{3}[1-9]|[2-9][0-9]{3})px/);
    expect(modalCss).not.toMatch(
      /max-width:\s*(?:100[1-9]|10[1-9][0-9]|1[1-9][0-9]{2}|[2-9][0-9]{3})px/
    );
  });

  it('keeps the safe area on every edge it touches', () => {
    const stage = sliceCssRule(modalCss, '.stage');
    expect(stage).toContain('env(safe-area-inset-top, 0px)');
    expect(stage).toContain('env(safe-area-inset-left, 0px)');
    expect(stage).toContain('env(safe-area-inset-right, 0px)');
    expect(sliceCssRule(modalCss, '.pageFooter')).toContain('env(safe-area-inset-bottom)');
    const short = modalCss.slice(modalCss.indexOf('@media (max-height: 480px)'));
    expect(short.slice(0, short.indexOf('@keyframes'))).toContain(
      'env(safe-area-inset-bottom, 0px)'
    );
  });

  it('uses schema inks for the placeholder and the caret', () => {
    for (const offSchema of ['#697581', '#5b626a', '#6b7784', '#5bb8ff']) {
      expect(modalCss).not.toContain(offSchema);
    }
    expect(modalCss).toMatch(/::placeholder\s*\{\s*color:\s*#9aa5b3;/);
    expect(modalCss).toContain('caret-color: #45adff;');
  });

  it('offers a clean Title Case placeholder', () => {
    expect(modalSource).not.toContain('E.G.');
    expect(modalSource).toContain('placeholder="Name Your Club"');
  });
});

describe('Club Discovery shows only what a club actually has', () => {
  it('holds neither fabricated literal in its source', () => {
    expect(discoverySource).not.toContain('Welcome To Our Club');
    expect(discoverySource).not.toContain('Texas Holdem');
  });

  it('renders no description and no games for a club that has none', async () => {
    state.clubRows = [
      {
        id: 'club-bare',
        name: 'Bare Room',
        description: null,
        tags: null,
        game_type: null,
        member_count: 3,
        table_count: 0,
        is_public: true,
      },
      {
        id: 'club-full',
        name: 'Full Room',
        description: 'nightly mixed games',
        tags: ['plo'],
        game_type: null,
        member_count: 9,
        table_count: 1,
        is_public: true,
      },
    ];
    const { container } = render(<ClubDiscovery />);
    await screen.findByText('Bare Room');

    expect(container.textContent).not.toContain('Welcome To Our Club');
    expect(container.textContent).not.toContain('Texas Holdem');
    // One description and one Games row: the tagged, described club's only.
    expect(container.querySelectorAll('.club-discovery__desc')).toHaveLength(1);
    expect(screen.getAllByText('Games')).toHaveLength(1);
    // Data is Title Cased where it prints, acronyms stay shouted.
    expect(screen.getByText('Nightly Mixed Games')).toBeInTheDocument();
    expect(screen.getByText('PLO')).toBeInTheDocument();
  });
});
