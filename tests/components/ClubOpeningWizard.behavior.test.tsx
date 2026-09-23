import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  report: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));

import ClubOpeningWizard from '../../src/components/club/ClubOpeningWizard';

const onClose = vi.fn();
const onComplete = vi.fn();

function mount(props: Partial<React.ComponentProps<typeof ClubOpeningWizard>> = {}) {
  return render(
    <ClubOpeningWizard
      clubId="club-1"
      clubName="River Kings"
      clubBank={100000}
      onClose={onClose}
      onComplete={onComplete}
      {...props}
    />
  );
}

const primary = () =>
  (screen.queryByRole('button', { name: 'Continue Opening Setup' }) ??
    screen.getByRole('button', { name: 'Complete Opening Setup' })) as HTMLButtonElement;
const next = () => fireEvent.click(primary());
const choose = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const confirmTransfer = () => fireEvent.click(screen.getByRole('switch'));
const alertText = () => screen.queryByRole('alert')?.textContent ?? '';

/** Walks to Review. `paid` funds every system; otherwise every answer is Not Now. */
function walkToReview({ paid = false, tagline = 'Where The River Always Pays' } = {}) {
  next(); // Opening Review -> Tag Line
  if (tagline) {
    fireEvent.change(screen.getByLabelText(/Club Tag Line/), { target: { value: tagline } });
  }
  next(); // -> Rake
  next(); // -> BBJ
  choose(paid ? /^Enable BBJ/ : /^Not Now/);
  if (paid) confirmTransfer();
  next(); // -> Spins (defaults to Not Now, no chips)
  next(); // -> Promotion
  choose(paid ? /^Create Promotion/ : /^Not Now/);
  if (paid) confirmTransfer();
  next(); // -> Leaderboards
  if (paid) {
    choose(/^Pay Weekly Prizes/);
    confirmTransfer();
  }
  next(); // -> Review
}

const okReceipt = (operationId: string, extra: Record<string, unknown> = {}) => ({
  data: {
    success: true,
    already_completed: false,
    club_id: 'club-1',
    club_bank_after: 98900,
    operation_id: operationId,
    ...extra,
  },
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockReset();
  mocks.from.mockReset();
});

describe('no silent chip movement', () => {
  it('starts with BBJ and Promotion unanswered and blocks Continue until the owner answers', () => {
    mount();
    next();
    fireEvent.change(screen.getByLabelText(/Club Tag Line/), { target: { value: 'A Real Line' } });
    next();
    next();
    expect(screen.getByRole('button', { name: /^Enable BBJ/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: /^Not Now/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(alertText()).toBe('Choose Enable BBJ Or Not Now Before Continuing');
    expect(primary()).toBeDisabled();

    choose(/^Enable BBJ/);
    expect(alertText()).toBe('Confirm The Exact BBJ Seed Transfer Before Continuing');
    expect(primary()).toBeDisabled();
    expect(
      screen.getByRole('switch', {
        name: 'Transfer Exactly 100 Chips From The Club Bank Into The Bad Beat Jackpot Main Bank',
      })
    ).not.toBeChecked();
    confirmTransfer();
    expect(primary()).toBeEnabled();

    // Changing the amount withdraws the confirmation.
    fireEvent.change(screen.getByLabelText(/BBJ Opening Seed/), { target: { value: '12500.75' } });
    expect(
      screen.getByRole('switch', {
        name: 'Transfer Exactly 12,500 Chips From The Club Bank Into The Bad Beat Jackpot Main Bank',
      })
    ).not.toBeChecked();
    expect(primary()).toBeDisabled();
    confirmTransfer();
    next();
    next();
    expect(alertText()).toBe('Choose Create Promotion Or Not Now Before Continuing');
    expect(primary()).toBeDisabled();
    choose(/^Create Promotion/);
    expect(alertText()).toBe('Confirm The Exact Promotion Budget Transfer Before Continuing');
    expect(
      screen.getByRole('switch', {
        name: 'Transfer Exactly 500 Chips From The Club Bank Into The Club Promo Wallet',
      })
    ).toBeInTheDocument();
  });

  it('sends zero seeds when the owner answers Not Now, and Leaderboards default to Display Only', async () => {
    mocks.rpc.mockImplementation((_name: string, args: { p_operation_id: string }) =>
      Promise.resolve(okReceipt(args.p_operation_id, { club_bank_after: 100000 }))
    );
    mount();
    walkToReview();
    expect(screen.getByText('Display Only')).toBeInTheDocument();
    await act(async () => next());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const args = mocks.rpc.mock.calls[0][1];
    expect(args).toMatchObject({
      p_bbj_enabled: false,
      p_bbj_seed: 0,
      p_spins_enabled: false,
      p_spin_seed: 0,
      p_promo_enabled: false,
      p_promo_budget: 0,
      p_leaderboard_rewards_enabled: false,
      p_leaderboard_prize_budget: 0,
    });
  });

  it('keeps Display Only as the recommended leaderboard default', () => {
    mount();
    next();
    fireEvent.change(screen.getByLabelText(/Club Tag Line/), { target: { value: 'A Real Line' } });
    next();
    next();
    choose(/^Not Now/);
    next();
    next();
    choose(/^Not Now/);
    next();
    expect(screen.getByRole('button', { name: /^Display Only/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText('Recommended For New Clubs')).toBeInTheDocument();
    expect(primary()).toBeEnabled();
  });
});

describe('paid leaderboards the server would reject', () => {
  function toLeaderboards(promo: 'create' | 'not_now') {
    mount();
    next();
    fireEvent.change(screen.getByLabelText(/Club Tag Line/), { target: { value: 'A Real Line' } });
    next();
    next();
    choose(/^Not Now/);
    next();
    next();
    if (promo === 'create') {
      choose(/^Create Promotion/);
      confirmTransfer();
    } else {
      choose(/^Not Now/);
    }
    next();
    choose(/^Pay Weekly Prizes/);
  }

  it('refuses a prize budget above the promotion budget and disables presets that cannot pass', () => {
    toLeaderboards('create');
    const presets = screen.getByLabelText('Suggested Leaderboard Prize Budgets');
    expect(within(presets).getByRole('button', { name: '100 Chips' })).toBeEnabled();
    expect(within(presets).getByRole('button', { name: '500 Chips' })).toBeEnabled();
    expect(within(presets).getByRole('button', { name: '1K Chips' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Weekly Prize Budget/), { target: { value: '1000' } });
    expect(alertText()).toBe(
      'Weekly Prize Budget Cannot Exceed The 500 Chip Promotion Budget. Raise The Promotion Budget Or Lower The Prize Budget'
    );
    expect(primary()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Weekly Prize Budget/), { target: { value: '500' } });
    expect(alertText()).toBe('Confirm The Exact Leaderboard Prize Seed Transfer Before Continuing');
    confirmTransfer();
    expect(primary()).toBeEnabled();
  });

  it('refuses every paid budget when no promotion was created', () => {
    toLeaderboards('not_now');
    const presets = screen.getByLabelText('Suggested Leaderboard Prize Budgets');
    for (const button of within(presets).getAllByRole('button')) expect(button).toBeDisabled();
    expect(alertText()).toContain('Go Back And Create A Promotion, Or Choose Display Only');
    expect(primary()).toBeDisabled();
  });

  it('shows a whole-chip split that sums to the budget and refuses budgets the server would split into decimals', () => {
    toLeaderboards('create');
    fireEvent.change(screen.getByLabelText(/Weekly Prize Budget/), { target: { value: '330' } });
    expect(screen.getByText('1st 165')).toBeInTheDocument();
    expect(screen.getByText('2nd 99')).toBeInTheDocument();
    expect(screen.getByText('3rd 66')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Weekly Prize Budget/), { target: { value: '105' } });
    expect(screen.getByText('1st 53')).toBeInTheDocument();
    expect(screen.getByText('2nd 31')).toBeInTheDocument();
    expect(screen.getByText('3rd 21')).toBeInTheDocument();
    expect(alertText()).toBe(
      'Leaderboard Prize Budget Must Be A Multiple Of 10 Chips So Every Prize Is A Whole Chip Amount'
    );
    expect(primary()).toBeDisabled();
  });
});

describe('figures', () => {
  it('prints compact chips without decimals and shows a real shortfall in place of a clamped zero', () => {
    mount({ clubBank: 600.75 });
    const container = document.body;
    expect(screen.getByLabelText('600 Chips In Club Bank')).toBeInTheDocument();
    walkToReview({ paid: true });
    // 100 BBJ + 500 Promotion + 500 Leaderboards against a 600 chip bank.
    const balance = container.querySelector('.club-setup-wizard__ledger-balance');
    expect(balance).toHaveClass('is-short');
    expect(balance).toHaveTextContent('Short By 500 Chips');
    expect(container.querySelector('.club-setup-wizard__ledger-total')).toHaveTextContent(
      '1.1K Chips'
    );
    expect(alertText()).toBe('Setup Allocation Exceeds The Club Bank');
    expect(primary()).toBeDisabled();
    expect(container.textContent).not.toMatch(/\d\.\d\d/);
  });

  it('confirms the exact total on the review screen', () => {
    mount({ clubBank: 100000 });
    walkToReview({ paid: true });
    expect(
      screen.getByText(/Completing Setup Transfers Exactly 1,100 Chips From The Club/)
    ).toBeInTheDocument();
  });

  it('tells the truth about leaderboard funding', () => {
    mount();
    walkToReview({ paid: true });
    const container = document.body;
    const text = container.textContent ?? '';
    expect(text).toContain('The Club Bank Is Never Debited For Leaderboard Prizes');
    expect(text).toContain('That Round Stays Unpaid And Is Retried Automatically');
    expect(text).not.toContain('Covers Any Overlay');
    expect(text).not.toContain('—');
  });
});

describe('request key, retries and an earlier setup', () => {
  it('holds one key across an unknown outcome and reports a recognised retry as applied', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'TypeError: Failed to fetch', code: '' },
      })
      .mockImplementationOnce((_name: string, args: { p_operation_id: string }) =>
        Promise.resolve(okReceipt(args.p_operation_id, { already_completed: true }))
      );
    mount();
    walkToReview();
    await act(async () => next());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Club Opening Setup Could Not Be Confirmed. Check Your Connection And Try Again'
    );
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => next());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const [first, second] = mocks.rpc.mock.calls.map((call) => call[1].p_operation_id);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(mocks.toast.success).toHaveBeenCalledWith('Club Opening Setup Completed');
    expect(onComplete).toHaveBeenCalledWith({
      clubBankAfter: 98900,
      spinsEnabled: false,
      tagline: 'Where The River Always Pays',
    });
  });

  it('rotates the key after a definitive server refusal and shows the server reason', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Club Bank Has 50 Chips But Setup Requires 100.00', code: 'P0001' },
      })
      .mockImplementationOnce((_name: string, args: { p_operation_id: string }) =>
        Promise.resolve(okReceipt(args.p_operation_id))
      );
    mount();
    walkToReview();
    await act(async () => next());
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'Club Bank Has 50 Chips But Setup Requires 100.00'
      )
    );
    await act(async () => next());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const [first, second] = mocks.rpc.mock.calls.map((call) => call[1].p_operation_id);
    expect(second).not.toBe(first);
  });

  it('never reports local answers as applied when an earlier setup owns the club', async () => {
    mocks.rpc.mockResolvedValue(
      okReceipt('an-earlier-operation', { already_completed: true, club_bank_after: 41000 })
    );
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { tagline: 'The Line Saved Earlier', spins_enabled: true },
      error: null,
    });
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    mount();
    walkToReview({ tagline: 'A Different Local Line' });
    await act(async () => next());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'Opening Setup Was Already Completed For This Club. Your New Answers Were Not Applied'
    );
    expect(onComplete).toHaveBeenCalledWith({
      clubBankAfter: 41000,
      spinsEnabled: true,
      tagline: 'The Line Saved Earlier',
    });
  });

  it('hands the page nothing when the saved setup cannot be read', async () => {
    mocks.rpc.mockResolvedValue(okReceipt('an-earlier-operation', { already_completed: true }));
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'Denied', code: '42501' } });
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    mount();
    walkToReview();
    await act(async () => next());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onComplete).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({ code: '42501' }),
      'ClubOpeningWizard.appliedState'
    );
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'Opening Setup Was Already Completed For This Club. Reload To See The Saved Setup'
    );
  });

  it('sends one request for a double tap and locks every way out while saving', async () => {
    let release: (value: unknown) => void = () => {};
    mocks.rpc.mockImplementation(
      (_name: string, args: { p_operation_id: string }) =>
        new Promise((resolvePromise) => {
          release = () => resolvePromise(okReceipt(args.p_operation_id));
        })
    );
    mount();
    walkToReview();
    const finish = primary();
    await act(async () => {
      fireEvent.click(finish);
      fireEvent.click(finish);
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close Opening Wizard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous Opening Step' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => release(null));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});

describe('dialog behavior and tag line', () => {
  it('shows one Close control on the first step and closes on Escape when idle', () => {
    mount();
    expect(screen.getAllByRole('button', { name: 'Close Opening Wizard' })).toHaveLength(1);
    next();
    expect(screen.getAllByRole('button', { name: 'Close Opening Wizard' })).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab inside the dialog, painted plates included', () => {
    render(
      <>
        <button type="button">Page Behind</button>
        <ClubOpeningWizard
          clubId="club-1"
          clubName="River Kings"
          clubBank={1000}
          onClose={onClose}
          onComplete={onComplete}
        />
      </>
    );
    const dialog = screen.getByRole('dialog');
    const plate = screen.getByRole('button', { name: 'Continue Opening Setup' });
    expect(dialog).toContainElement(plate);
    const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled])');
    const last = focusable[focusable.length - 1];
    expect(last.closest('.sc__foot')).not.toBeNull();
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusable[0]);
    screen.getByRole('button', { name: 'Page Behind' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('prefills the saved tag line and works without one', () => {
    const first = mount({ initialTagline: '  Home Of The Friday Game  ' });
    next();
    expect(screen.getByLabelText(/Club Tag Line/)).toHaveValue('Home Of The Friday Game');
    expect(primary()).toBeEnabled();
    first.unmount();

    mount({ initialTagline: null });
    next();
    expect(screen.getByLabelText(/Club Tag Line/)).toHaveValue('');
    expect(alertText()).toBe('Write A Custom Club Tag Line');
    expect(primary()).toBeDisabled();
  });

  it('still refuses the Shark Club line for any other club, prefilled or typed', () => {
    mount({ initialTagline: 'All Fish Of All Shapes And Sizes Are Welcome' });
    next();
    expect(alertText()).toBe('That Tag Line Belongs To Shark Club');
    expect(primary()).toBeDisabled();
  });
});
