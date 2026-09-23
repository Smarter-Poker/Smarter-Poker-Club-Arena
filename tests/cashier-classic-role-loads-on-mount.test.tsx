/**
 * The role load on /clubs/:clubId/cashier-classic must survive the mount.
 *
 * loadUserContext captures contextVersionRef before its first await and
 * abandons the load if the version has moved. When the effect that bumps the
 * version was declared AFTER the effect that starts the load, React ran the
 * load first and the bump second in the same flush, so every mount and every
 * club switch discarded its own role read. userRole never left its default and
 * owners, admins and agents were shown the player Cashier (Buy-In / Cash-Out /
 * History). These tests render the real page and require the staff tab set.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CashierPage from '../src/pages/CashierPage';
import { supabase } from '../src/lib/supabase';
import { engineChannelClient } from '../src/services/EngineStateClient';
import { masterBus } from '../src/core/MasterBus';

vi.unmock('../src/core/MasterBus');

const OWNER = '22222222-2222-4222-8222-222222222222';
const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '33333333-3333-4333-8333-333333333333';
const ROLE_BY_CLUB: Record<string, string> = { [CLUB]: 'owner', [OTHER_CLUB]: 'admin' };
const mocks = vi.hoisted(() => ({
  loadBalances: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: OWNER } }) }));
vi.mock('../src/stores/useWalletStore', () => ({
  useWalletStore: () => ({ loadBalances: mocks.loadBalances, mintChips: vi.fn() }),
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/clubIdResolver')>()),
  resolveClubUUID: async (id: string) => id,
}));
vi.mock('../src/utils/retryFetch', () => ({ retryFetch: (read: () => unknown) => read() }));
vi.mock('../src/utils/clubQuickLink', () => ({
  CHIP_BALANCE_EVENTS: [],
  fetchClubChipBalances: async () => new Map(),
  clearClubChipBalanceCache: vi.fn(),
  resolveTargetClub: vi.fn(),
  readCachedQuickLinkClubs: vi.fn(),
  fetchQuickLinkClubs: vi.fn(),
}));
vi.mock('../src/components/club/CashierClubSwitcher', () => ({ default: () => null }));
vi.mock('../src/components/agent/AgentPromoPanel', () => ({ default: () => null }));
vi.mock('../src/components/wallet/DynamicWallet', () => ({ default: () => null }));
vi.mock('../src/components/wallet/WalletCashierModal', () => ({ default: () => null }));
vi.mock('../src/components/wallet/PlayerWalletModal', () => ({ default: () => null }));
vi.mock('../src/components/wallet/CashoutRequestModal', () => ({ default: () => null }));
vi.mock('../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

/** Every club the page asked club_members for this user's role in. */
let roleReads: string[];

function ClubNavigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/cashier?club=${OTHER_CLUB}`)}>Switch Club</button>;
}
function start() {
  return render(
    <MemoryRouter initialEntries={[`/cashier?club=${CLUB}`]}>
      <CashierPage />
      <ClubNavigation />
    </MemoryRouter>
  );
}
async function expectStaffTabs() {
  expect(await screen.findByRole('tab', { name: 'Mint' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Distribute' })).toBeInTheDocument();
  // The clamp only runs once the role is known; a staff member stays on Send.
  expect(await screen.findByRole('tab', { name: 'Send', selected: true })).toBeInTheDocument();
}

describe('Cashier Classic loads the viewer role on mount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    roleReads = [];
    vi.spyOn(engineChannelClient, 'onStatusChange').mockReturnValue(() => {});
    vi.spyOn(engineChannelClient, 'onFinancialUpdate').mockReturnValue(() => {});
    const channel = { on: vi.fn(), subscribe: vi.fn() };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
    vi.spyOn(masterBus, 'getOrCreateChannel').mockReturnValue(channel as never);
    vi.spyOn(masterBus, 'registerChannelFactory').mockImplementation(() => {});
    vi.spyOn(masterBus, 'removeChannelFactory').mockImplementation(() => {});
    vi.spyOn(masterBus, 'removeRegisteredChannel').mockImplementation(() => {});
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'or', 'order', 'limit', 'is', 'in'])
        query[method] = () => query;
      query.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      };
      query.maybeSingle = () => {
        if (table === 'club_members') roleReads.push(String(filters.club_id));
        return Promise.resolve({
          data:
            table === 'club_members'
              ? { role: ROLE_BY_CLUB[String(filters.club_id)] ?? 'member' }
              : table === 'clubs'
                ? { name: 'Shark Club', union_id: null }
                : table === 'agents'
                  ? { agent_wallet_balance: 500 }
                  : null,
          error: null,
        });
      };
      query.then = (done: (result: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(done);
      return query as never;
    });
  });

  it('shows an owner the staff tabs on first mount, not the player cashier', async () => {
    start();
    await expectStaffTabs();
    expect(roleReads).toContain(CLUB);
  });

  it('loads the new club role after switching clubs', async () => {
    start();
    await expectStaffTabs();
    fireEvent.click(screen.getByRole('button', { name: 'Switch Club' }));
    await waitFor(() => expect(roleReads).toContain(OTHER_CLUB));
    // admin on a standalone club: Send, Distribute and Mint, same as the owner.
    await expectStaffTabs();
  });
});
