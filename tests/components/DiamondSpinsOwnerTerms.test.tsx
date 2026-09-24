import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondSpinsOwnerTerms, {
  DIAMOND_SPINS_ADDENDUM_VERSION,
  DIAMOND_SPINS_TERMS_VERSION,
} from '../../src/components/games/DiamondSpinsOwnerTerms';

/**
 * Owner ruling 2026-09-21 (R14): the daily profit burn is published as a dated
 * addendum with its own permanent receipt. The base agreement still gates play,
 * so an existing host keeps its games open while the owner acknowledges the
 * notice, and a new host accepts both in one tap.
 */
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  report: vi.fn(),
  user: { id: 'owner-a' } as { id: string } | null,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));

const CLUB = '22222222-2222-4222-8222-222222222222';
const BASE_TEXT =
  'I Authorize Diamond Spins For This Host. A Reward Must Be Funded Before It Is Awarded.';
const ADDENDUM_TEXT =
  'Daily Settlement And Profit Burn Addendum, September 21, 2026. On A Day With A Positive Net, The Platform Burns 20% Of The Net Diamonds.';
function agreement(overrides: {
  accepted?: boolean;
  addendumAccepted?: boolean;
  isOwner?: boolean;
  version?: string;
  addendumVersion?: string;
}) {
  const accepted = overrides.accepted ?? true;
  const addendumAccepted = overrides.addendumAccepted ?? false;
  return {
    ok: true,
    is_owner: overrides.isOwner ?? true,
    accepted,
    accepted_at: accepted ? '2026-09-14T12:00:00Z' : null,
    terms: BASE_TEXT,
    terms_version: overrides.version ?? DIAMOND_SPINS_TERMS_VERSION,
    addendum: {
      version: overrides.addendumVersion ?? DIAMOND_SPINS_ADDENDUM_VERSION,
      text: ADDENDUM_TEXT,
      accepted: addendumAccepted,
      accepted_at: addendumAccepted ? '2026-09-21T20:30:00Z' : null,
      profit_burn_bps: 2000,
    },
    acknowledged: accepted && addendumAccepted,
  };
}
const click = async (name: string) => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name })));
};

beforeEach(() => {
  mocks.user = { id: 'owner-a' };
  mocks.rpc.mockReset();
  mocks.report.mockReset();
});
afterEach(cleanup);

describe('the owner agreement and the daily profit burn notice', () => {
  it('shows an existing host the notice as an acknowledgement while play stays open', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: agreement({}), error: null })
      .mockResolvedValueOnce({ data: agreement({ addendumAccepted: true }), error: null });
    render(<DiamondSpinsOwnerTerms clubId={CLUB} />);
    await screen.findByText(ADDENDUM_TEXT);
    expect(screen.getByText(BASE_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Daily Profit Burn Notice (20%)')).toBeInTheDocument();
    expect(screen.getByText('Notice')).toBeInTheDocument();
    expect(screen.getByText(/Accepted By The Wallet Owner On/)).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'fn_diamond_spins_owner_terms', {
      p_club_id: CLUB,
      p_agree: false,
    });
    const acknowledge = screen.getByRole('button', { name: 'Acknowledge Notice' });
    expect(acknowledge).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I Have Read The Daily Profit Burn Notice.'));
    expect(acknowledge).toBeEnabled();
    await click('Acknowledge Notice');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'fn_diamond_spins_owner_terms', {
      p_club_id: CLUB,
      p_agree: true,
    });
    expect(screen.getByText(/Notice Acknowledged By The Wallet Owner On/)).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('—');
  });

  it('asks a new host owner to accept the agreement and the notice together', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: agreement({ accepted: false }), error: null })
      .mockResolvedValueOnce({
        data: agreement({ accepted: true, addendumAccepted: true }),
        error: null,
      });
    const onAccepted = vi.fn();
    render(<DiamondSpinsOwnerTerms clubId={CLUB} onAccepted={onAccepted} />);
    await screen.findByText(ADDENDUM_TEXT);
    expect(screen.getByText('Required')).toBeInTheDocument();
    fireEvent.click(
      screen.getByLabelText(
        'I Have Read And Agree To These Wallet Obligations And The Daily Profit Burn Notice.'
      )
    );
    await click('Accept Agreement');
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_diamond_spins_owner_terms', {
      p_club_id: CLUB,
      p_agree: true,
    });
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });

  it('lets an operator who is not the wallet owner read but never accept', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: agreement({ isOwner: false }), error: null });
    render(<DiamondSpinsOwnerTerms clubId={CLUB} />);
    await screen.findByText(ADDENDUM_TEXT);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge Notice' })).toBeDisabled();
    expect(
      screen.getByText(
        'The Wallet Owner Acknowledges The Daily Profit Burn Notice. Play Stays Open Meanwhile.'
      )
    ).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['base version', { version: 'diamond-spins-2026-09-21-v2' }],
    ['addendum version', { addendumVersion: 'diamond-spins-2026-09-14-v1' }],
  ])('refuses an agreement whose %s is not the one this build knows', async (_label, bad) => {
    mocks.rpc.mockResolvedValueOnce({ data: agreement(bad), error: null });
    render(<DiamondSpinsOwnerTerms clubId={CLUB} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Agreement Could Not Be Loaded. Try Refresh.'
    );
    expect(mocks.report).toHaveBeenCalledOnce();
    expect(screen.queryByText(ADDENDUM_TEXT)).not.toBeInTheDocument();
  });

  it('refuses a response with no addendum instead of hiding the burn', async () => {
    const legacy = agreement({}) as Record<string, unknown>;
    delete legacy.addendum;
    delete legacy.acknowledged;
    mocks.rpc.mockResolvedValueOnce({ data: legacy, error: null });
    render(<DiamondSpinsOwnerTerms clubId={CLUB} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could Not Be Loaded');
  });
});
