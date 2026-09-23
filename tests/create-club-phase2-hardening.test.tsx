/**
 * Create A Club, Phase 2 hardening (2026-09-20).
 *
 * Each block pins one repaired behavior and fails against the code it replaced:
 *   - the focus trap wrapped only the scroll body, so Tab could never reach the
 *     painted Close / Create Club plates;
 *   - the unsaved-changes guard was window.confirm;
 *   - the draft key was not scoped to an account;
 *   - the success toast named the text box, not the club the server returned;
 *   - Launch Settings were bare checkboxes;
 *   - Club Discovery invented a description and a game tag.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    render(<CreateClubModal isOpen onClose={vi.fn()} />);
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput?.getAttribute('tabindex')).toBe('-1');
  });
});

describe('the unsaved-changes guard is an in-app console', () => {
  it('never calls window.confirm', () => {
    expect(modalSource).not.toMatch(/window\.confirm|\bconfirm\(/);
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

    const guard = screen.getByRole('alertdialog', { name: 'Close Create Club?' });
    expect(guard).toBeVisible();
    expect(guard.textContent).toContain('Stay Saved As A Draft On This Device');
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The safe answer holds focus, and Tab cannot leave the two plates.
    const keepEditing = within(guard).getByRole('button', { name: 'Keep Editing' });
    const closeNow = within(guard).getByRole('button', { name: 'Close Now' });
    expect(document.activeElement).toBe(keepEditing);
    await user.tab();
    expect(document.activeElement).toBe(closeNow);
    await user.tab();
    expect(document.activeElement).toBe(keepEditing);

    // Escape answers the guard the way it answered the native one: cancel.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Club Name')).toHaveValue('Alpha Room');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close Now' })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes a pristine form at once, with no guard', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CreateClubModal isOpen onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
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
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
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
    expect(state.toast.success).toHaveBeenCalledWith('Club "Original Room" Created Successfully!');
    expect(
      state.toast.success.mock.calls.some(([message]) => String(message).includes('Renamed Room'))
    ).toBe(false);
  });
});

describe('Launch Settings use the labeled On / Off switch', () => {
  it('prints On or Off and carries the choice into the create call', async () => {
    const user = userEvent.setup();
    state.create.mockResolvedValue({ id: 'club-1', name: 'Alpha Room' });
    render(<CreateClubModal isOpen onClose={vi.fn()} />);

    const discoverable = screen.getByRole('switch', { name: 'Discoverable In Club Arena' });
    const review = screen.getByRole('switch', { name: 'Review Join Requests' });
    expect(discoverable).toBeChecked();
    expect(review).not.toBeChecked();
    const settings = discoverable.closest('fieldset') as HTMLElement;
    expect(within(settings).getByText('On')).toBeInTheDocument();
    expect(within(settings).getByText('Off')).toBeInTheDocument();

    await user.click(discoverable);
    await user.click(review);
    expect(discoverable).not.toBeChecked();
    expect(review).toBeChecked();

    await makeCreatable(user, 'Alpha Room');
    await user.click(screen.getByRole('button', { name: 'Create Club' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0][0]).toMatchObject({
      is_public: false,
      requires_approval: true,
    });
  });

  it('imports the shared Toggle, whose own stylesheet travels with it', () => {
    expect(modalSource).toContain("import { Toggle } from '../table-config/controls';");
    expect(read('src/components/table-config/controls.tsx')).toContain(
      "import '../../pages/TableConfigPage.css';"
    );
    // The consent checkbox is the only native checkbox left in the modal.
    expect(modalSource.match(/type="checkbox"/g) ?? []).toHaveLength(1);
  });
});

describe('the console fits short and notched viewports', () => {
  it('narrows the console by height and never raises the 1000px ceiling', () => {
    expect(modalCss).toMatch(/--sc-max:\s*min\(\s*1000px,/);
    expect(modalCss).toMatch(/--cc-shell-height:\s*calc\(100dvh - var\(--cc-inset-top\)/);
    expect(modalCss).not.toMatch(/--sc-max:\s*(?:1[0-9]{3}[1-9]|[2-9][0-9]{3})px/);
  });

  it('keeps the safe area on a phone-width sheet', () => {
    const phone = modalCss.slice(modalCss.indexOf('@media (max-width: 560px)'));
    const block = phone.slice(0, phone.indexOf('@container'));
    expect(block).toContain('--cc-inset-top: env(safe-area-inset-top, 0px)');
    expect(block).toContain('--cc-inset-bottom: env(safe-area-inset-bottom, 0px)');
    expect(block).not.toMatch(/padding:\s*0\s*;/);
  });

  it('uses schema inks for the placeholder and the bevel', () => {
    expect(modalCss).not.toContain('#697581');
    expect(modalCss).not.toContain('#5b626a');
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

  it('renders no description and no tags for a club that has none', async () => {
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
        description: 'Nightly Mixed Games',
        tags: ['Omaha'],
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
    expect(container.querySelectorAll('.club-desc')).toHaveLength(1);
    expect(container.querySelectorAll('.club-tags')).toHaveLength(1);
    expect(screen.getByText('Nightly Mixed Games')).toBeInTheDocument();
    expect(screen.getByText('Omaha')).toBeInTheDocument();
  });
});
