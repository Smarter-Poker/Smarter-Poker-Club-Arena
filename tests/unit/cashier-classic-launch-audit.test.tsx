/**
 * Club Arena Cashier launch audit (2026-10-09): the classic cashier page.
 *
 * Each case pins one finding from the pages / services audit:
 *   P-01  a failed role read is a failure, never a plain member
 *   P-02  a stale club load cannot clear the next club's loading state
 *   P-04  chip amounts take a decimal keypad; Mint takes whole chips
 *   P-05  the high-value Send confirm is a real dialog
 *   P-06  Buy-In is only a tab when the URL names a table
 *   P-07  the viewer is never a Send recipient (and still a Distribute one)
 *   P-13/14/15/19/20  console law, dead code, Title Case, a11y, parsing
 *   S-03  the Mint tab holds one p_op_id across a failed attempt
 *   G-01  the Send confirm and its previews read the spelling, not a float
 *   G-03  the Mint field reads grouped thousands like every other amount
 *   G-04  a failed club read says the club, not the role
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CashierPage, { parseChipAmount, parseWholeChipAmount } from '../../src/pages/CashierPage';
import { supabase } from '../../src/lib/supabase';
import { engineChannelClient } from '../../src/services/EngineStateClient';
import { masterBus } from '../../src/core/MasterBus';

vi.unmock('../../src/core/MasterBus');

const OWNER = '22222222-2222-4222-8222-222222222222';
const PLAYER_ONE = '44444444-4444-4444-8444-444444444444';
const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '33333333-3333-4333-8333-333333333333';
const MINT_RATE = 100;

const mocks = vi.hoisted(() => ({
  loadBalances: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
  reportError: vi.fn(),
  walletProps: [] as Array<{ roleReady: boolean }>,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: OWNER } }) }));
vi.mock('../../src/stores/useWalletStore', () => ({
  useWalletStore: () => ({ loadBalances: mocks.loadBalances }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => mocks.reportError(...args),
}));
vi.mock('../../src/utils/settlementLock', () => ({
  checkSettlementLock: async () => ({ locked: false }),
}));
vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: async (id: string) => id,
}));
vi.mock('../../src/utils/retryFetch', () => ({ retryFetch: (read: () => unknown) => read() }));
vi.mock('../../src/utils/clubQuickLink', () => ({
  CHIP_BALANCE_EVENTS: [],
  fetchClubChipBalances: async () => new Map(),
  clearClubChipBalanceCache: vi.fn(),
  resolveTargetClub: vi.fn(),
  readCachedQuickLinkClubs: vi.fn(),
  fetchQuickLinkClubs: vi.fn(),
}));
vi.mock('../../src/components/club/CashierClubSwitcher', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentPromoPanel', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/DynamicWallet', () => ({
  default: (props: { roleReady: boolean }) => {
    mocks.walletProps.push({ roleReady: props.roleReady });
    return <div data-testid="dynamic-wallet" data-role-ready={String(props.roleReady)} />;
  },
}));
vi.mock('../../src/components/wallet/WalletCashierModal', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/PlayerWalletModal', () => ({ default: () => null }));
vi.mock('../../src/components/wallet/CashoutRequestModal', () => ({ default: () => null }));
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

type RoleRead = { data: { role: string } | null; error: { code: string } | null };
type Deferred = { promise: Promise<RoleRead>; resolve: (value: RoleRead) => void };
function deferred(): Deferred {
  let resolve!: (value: RoleRead) => void;
  const promise = new Promise<RoleRead>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** How club_members.select('role') answers for each club. */
let roleReads: Record<string, () => Promise<RoleRead>>;
let rpcCalls: Array<[string, Record<string, unknown>]>;
let mintResponses: Array<{ data: unknown; error: unknown }>;

function ownerRead(): Promise<RoleRead> {
  return Promise.resolve({ data: { role: 'owner' }, error: null });
}
function playerRead(): Promise<RoleRead> {
  return Promise.resolve({ data: { role: 'player' }, error: null });
}

function installSupabase() {
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const query: Record<string, unknown> = {};
    let paged = false;
    for (const method of ['select', 'or', 'order', 'limit', 'is', 'in'])
      query[method] = () => query;
    query.range = () => {
      paged = true;
      return query;
    };
    query.eq = (column: string, value: unknown) => {
      filters[column] = value;
      return query;
    };
    query.maybeSingle = () => {
      if (table === 'club_members') {
        const read = roleReads[String(filters.club_id)] ?? playerRead;
        return read();
      }
      return Promise.resolve({
        data:
          table === 'clubs'
            ? { name: 'Shark Club', union_id: null }
            : table === 'agents'
              ? { agent_wallet_balance: 50_000 }
              : null,
        error: null,
      });
    };
    query.then = (done: (result: unknown) => unknown) => {
      const rows =
        table === 'club_members' && paged
          ? [
              {
                user_id: OWNER,
                role: 'owner',
                display_name: 'Me The Owner',
                nickname: null,
                chip_balance: 10,
                agent_id: null,
              },
              {
                user_id: PLAYER_ONE,
                role: 'player',
                display_name: 'Player One',
                nickname: null,
                chip_balance: 5,
                agent_id: null,
              },
            ]
          : [];
      return Promise.resolve({ data: rows, error: null }).then(done);
    };
    return query as never;
  });
  vi.mocked(supabase.rpc).mockImplementation(((name: string, args: Record<string, unknown>) => {
    rpcCalls.push([name, args]);
    if (name === 'fn_ca_bridge_rate') return Promise.resolve({ data: MINT_RATE, error: null });
    if (name === 'fn_mint_chips_from_diamonds') {
      const next = mintResponses.shift();
      return Promise.resolve(next ?? { data: { success: true, chips: 1 }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }) as never);
}

function ClubNavigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/cashier?club=${OTHER_CLUB}`)}>Switch Club</button>;
}
function start(entry = `/cashier?club=${CLUB}`) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CashierPage />
      <ClubNavigation />
    </MemoryRouter>
  );
}

const read = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
const CLASSIC = read('src/pages/CashierPage.tsx');

describe('Cashier Classic launch audit', () => {
  let nowMs: number;
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.walletProps.length = 0;
    rpcCalls = [];
    mintResponses = [];
    roleReads = { [CLUB]: ownerRead, [OTHER_CLUB]: ownerRead };
    nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    vi.spyOn(engineChannelClient, 'onStatusChange').mockReturnValue(() => {});
    vi.spyOn(engineChannelClient, 'onFinancialUpdate').mockReturnValue(() => {});
    const channel = { on: vi.fn(), subscribe: vi.fn() };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
    vi.spyOn(masterBus, 'getOrCreateChannel').mockReturnValue(channel as never);
    vi.spyOn(masterBus, 'registerChannelFactory').mockImplementation(() => {});
    vi.spyOn(masterBus, 'removeChannelFactory').mockImplementation(() => {});
    vi.spyOn(masterBus, 'removeRegisteredChannel').mockImplementation(() => {});
    installSupabase();
  });
  afterEach(() => {
    document.body.style.overflow = '';
  });

  // ── P-01 ─────────────────────────────────────────────────────────────────
  it('P-01: a failed role read shows an error with Retry and never the player tab set', async () => {
    roleReads[CLUB] = () => Promise.resolve({ data: null, error: { code: '57014' } });
    start();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your Cashier Role Could Not Be Read.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: '57014' }),
      'CashierPage.loadUserContext'
    );
    // No tab set at all: not Buy-In, not Cash-Out, nothing auto-selected.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('tabpanel')).toHaveLength(0);
    expect(screen.queryByText('Send Chips')).toBeNull();
    expect(screen.queryByText('Loading Your Cashier')).toBeNull();
    // DynamicWallet keeps its skeleton: the role is unknown, not 'player'.
    expect(screen.getByTestId('dynamic-wallet')).toHaveAttribute('data-role-ready', 'false');

    // Retry with the read now succeeding: the owner gets the staff tabs.
    roleReads[CLUB] = ownerRead;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('tab', { name: 'Mint' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Send', selected: true })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('dynamic-wallet')).toHaveAttribute('data-role-ready', 'true');
  });

  it('P-01 / G-04: a failed club read hides the cashier and names the club, not the role', async () => {
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'or', 'order', 'limit', 'is', 'in', 'eq', 'range'])
        query[method] = () => query;
      query.maybeSingle = () =>
        Promise.resolve(
          table === 'clubs'
            ? { data: null, error: { code: 'PGRST301' } }
            : table === 'club_members'
              ? { data: { role: 'owner' }, error: null }
              : { data: null, error: null }
        );
      query.then = (done: (result: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(done);
      return query as never;
    });
    start();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The Club Could Not Be Read.');
    expect(alert).not.toHaveTextContent('Your Cashier Role Could Not Be Read.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PGRST301' }),
      'CashierPage.loadUserContext'
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  // ── P-02 ─────────────────────────────────────────────────────────────────
  // Two lines of defence. CashierPage keys CashierContent on the club (via
  // useCashoutScopeKey), so a club switch remounts the content and the old
  // instance's loader sees isMounted=false. Should that key ever stop
  // covering the club, the finally itself now consults stale() too; the
  // source pin below holds that second line, the render below the first.
  it('P-02: the finally that clears loadingContext is guarded on stale()', () => {
    expect(CLASSIC).toContain('if (isMounted.current && !stale()) setLoadingContext(false);');
    expect(CLASSIC).not.toMatch(
      /finally \{\s*if \(isMounted\.current\) setLoadingContext\(false\);/
    );
  });

  it('P-02: a stale load for the previous club does not clear the next club loading state', async () => {
    const first = deferred();
    const second = deferred();
    roleReads[CLUB] = () => first.promise;
    roleReads[OTHER_CLUB] = () => second.promise;
    start();
    expect(await screen.findByText('Loading Your Cashier')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch Club' }));
    expect(await screen.findByText('Loading Your Cashier')).toBeInTheDocument();

    // Club A's (stale) response lands while B is still in flight.
    await act(async () => {
      first.resolve({ data: { role: 'owner' }, error: null });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByText('Loading Your Cashier')).toBeInTheDocument();
    expect(screen.getByTestId('dynamic-wallet')).toHaveAttribute('data-role-ready', 'false');
    // Nothing clamped the tab onto the player set in the meantime.
    expect(screen.queryByRole('tab', { name: 'Cash-Out', selected: true })).toBeNull();

    second.resolve({ data: { role: 'owner' }, error: null });
    expect(await screen.findByRole('tab', { name: 'Send', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Mint' })).toBeInTheDocument();
    expect(screen.queryByText('Loading Your Cashier')).toBeNull();
    // roleReady never flipped true before B's role arrived.
    const firstReady = mocks.walletProps.findIndex((p) => p.roleReady);
    expect(firstReady).toBeGreaterThan(-1);
    expect(mocks.walletProps.slice(0, firstReady).every((p) => !p.roleReady)).toBe(true);
  });

  // ── P-06 ─────────────────────────────────────────────────────────────────
  it('P-06: a player sees no Buy-In tab unless the URL names a table', async () => {
    roleReads[CLUB] = playerRead;
    const { unmount } = start();
    expect(
      await screen.findByRole('tab', { name: 'Cash-Out', selected: true })
    ).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Buy-In' })).toBeNull();
    unmount();
    start(`/cashier?club=${CLUB}&table=t1`);
    expect(await screen.findByRole('tab', { name: 'Buy-In' })).toBeInTheDocument();
  });

  // ── P-07 / P-04 / P-15 / P-19 ────────────────────────────────────────────
  it('P-07: the viewer is not a Send recipient, and still a Distribute one', async () => {
    start();
    expect(await screen.findByRole('tab', { name: 'Send', selected: true })).toBeInTheDocument();
    const sendSelect = (await screen.findByLabelText('Send To Recipient')) as HTMLSelectElement;
    await waitFor(() => expect(sendSelect.options.length).toBe(2));
    const sendIds = Array.from(sendSelect.options).map((o) => o.value);
    expect(sendIds).toContain(PLAYER_ONE);
    expect(sendIds).not.toContain(OWNER);
    expect(screen.getByLabelText('Search Recipients')).toHaveAttribute(
      'placeholder',
      'Search Member Or Role...'
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Distribute' }));
    const distSelect = (await screen.findByLabelText('Distribute To Player')) as HTMLSelectElement;
    await waitFor(() => expect(distSelect.options.length).toBe(3));
    const distIds = Array.from(distSelect.options).map((o) => o.value);
    expect(distIds).toContain(OWNER);
    expect(distIds).toContain(PLAYER_ONE);
  });

  it('P-04: chip amounts take a decimal keypad; the Mint field takes whole chips', async () => {
    start();
    await screen.findByRole('tab', { name: 'Send', selected: true });
    const send = document.getElementById('cashier-send-amount') as HTMLInputElement;
    expect(send).toHaveAttribute('inputmode', 'decimal');
    expect(send).toHaveAttribute('step', '0.01');

    fireEvent.click(screen.getByRole('tab', { name: 'Distribute' }));
    const dist = document.getElementById('cashier-distribute-amount') as HTMLInputElement;
    expect(dist).toHaveAttribute('inputmode', 'decimal');
    expect(dist).toHaveAttribute('step', '0.01');

    fireEvent.click(screen.getByRole('tab', { name: 'Cash-Out' }));
    const cashout = document.getElementById('cashier-amount') as HTMLInputElement;
    expect(cashout).toHaveAttribute('inputmode', 'decimal');
    expect(cashout).toHaveAttribute('step', '0.01');

    fireEvent.click(screen.getByRole('tab', { name: 'Mint' }));
    const mint = document.getElementById('cashier-amount') as HTMLInputElement;
    expect(mint).toHaveAttribute('inputmode', 'numeric');
    expect(mint).toHaveAttribute('step', '1');
  });

  it('P-15 / P-19: Title Case word controls, labelled panels, Home/End and pressed filters', async () => {
    start();
    const sendTab = await screen.findByRole('tab', { name: 'Send', selected: true });
    expect(sendTab).toHaveAttribute('id', 'cashier-tab-send');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'cashier-tab-send');
    expect(screen.getByText('Send To')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Send 0 Chips To Selected Recipient/ })
    ).toHaveTextContent('Confirm Send');

    // Home / End on the tablist
    sendTab.focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(await screen.findByRole('tab', { name: 'History', selected: true })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'History' }));
    const all = screen.getByRole('button', { name: 'All' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Credits' }));
    expect(screen.getByRole('button', { name: 'Credits' })).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
    expect(await screen.findByRole('tab', { name: 'Send', selected: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Mint' }));
    expect(screen.getByText('Chips To Mint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Mint' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Cash-Out' }));
    expect(screen.getByRole('button', { name: 'Check Or Request Cashout' })).toBeInTheDocument();
  });

  it('P-13 / P-14 / P-15: no console.warn, no promo remaps, no shouted strings in the source', () => {
    expect(CLASSIC).not.toContain('console.warn(');
    for (const dead of [
      "'Rate limit'",
      "'Insufficient promo'",
      "'Player not found'",
      "'Agent not found'",
    ])
      expect(CLASSIC).not.toContain(`msg.includes(${dead})`);
    for (const shouted of [
      'SEND TO:',
      'AMOUNT:',
      "'CONFIRM SEND'",
      'CANCEL\n',
      'CONFIRM SECURE CASHOUT',
      'CHIPS TO MINT:',
      'CONFIRM BUY-IN',
      'CONFIRM CASH-OUT',
      'CHECK OR REQUEST CASHOUT',
      'CONFIRM MINT',
      "'(YOU) '",
    ])
      expect(CLASSIC).not.toContain(shouted);
    // Two spellings of "unknown role" collapsed into one.
    expect(CLASSIC).not.toContain("useState<string>('member')");
    expect(CLASSIC).not.toContain("memberResult?.data?.role || 'member'");
    // The classic page no longer mints through the store.
    expect(CLASSIC).not.toContain('mintChips(');
    expect(CLASSIC).toContain("supabase.rpc(\n              'fn_mint_chips_from_diamonds'");
  });

  // ── P-05 ─────────────────────────────────────────────────────────────────
  it('P-05: the high-value Send confirm takes focus, closes on Escape and returns focus', async () => {
    start();
    await screen.findByRole('tab', { name: 'Send', selected: true });
    const sendSelect = (await screen.findByLabelText('Send To Recipient')) as HTMLSelectElement;
    await waitFor(() => expect(sendSelect.options.length).toBe(2));
    fireEvent.change(sendSelect, { target: { value: PLAYER_ONE } });
    fireEvent.change(document.getElementById('cashier-send-amount')!, {
      target: { value: '10000' },
    });
    const trigger = screen.getByRole('button', { name: /Send 10000 Chips To Selected Recipient/ });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'send-confirm-title');
    expect(dialog.className).toContain('consoleDialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.body.style.overflow).toBe('hidden');

    // Tab from the last focusable wraps to the first, never behind the dialog.
    const focusable = dialog.querySelectorAll<HTMLElement>('button:not(:disabled)');
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusable[0]);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.style.overflow).toBe('');
    expect(supabase.rpc).not.toHaveBeenCalledWith('fn_agent_wallet_send', expect.anything());
  });

  // ── G-01 ─────────────────────────────────────────────────────────────────
  async function sendTabWith(text: string) {
    start();
    await screen.findByRole('tab', { name: 'Send', selected: true });
    const sendSelect = (await screen.findByLabelText('Send To Recipient')) as HTMLSelectElement;
    await waitFor(() => expect(sendSelect.options.length).toBe(2));
    fireEvent.change(sendSelect, { target: { value: PLAYER_ONE } });
    const field = document.getElementById('cashier-send-amount') as HTMLInputElement;
    fireEvent.change(field, { target: { value: text } });
    return field;
  }
  const sendCalls = () => rpcCalls.filter(([name]) => name === 'fn_agent_wallet_send');

  it('G-01: "1e9" never reaches the high-value confirm, and nothing is sent', async () => {
    const field = await sendTabWith('1e9');
    expect(field.value).toBe('1e9');
    fireEvent.click(screen.getByRole('button', { name: /Send 1e9 Chips To Selected Recipient/ }));
    expect(await screen.findByText('Please Enter A Valid Amount')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sendCalls()).toHaveLength(0);
  });

  it('G-01: the confirm re-reads the typed spelling, so a changed field cannot ride the override', async () => {
    const field = await sendTabWith('10000');
    fireEvent.click(screen.getByRole('button', { name: /Send 10000 Chips To Selected Recipient/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(field, { target: { value: '1e9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Send' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Please Enter A Valid Amount')).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);

    // A different well-spelled figure than the one confirmed is refused too.
    fireEvent.change(field, { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: /Send 10000 Chips To Selected Recipient/ }));
    const again = await screen.findByRole('dialog');
    fireEvent.change(field, { target: { value: '20000' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Confirm Send' }));
    expect(
      await screen.findByText('The Amount Changed. Confirm The Send Again')
    ).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);
  });

  it('G-01: the After-balance preview and the Distribute label read parseChipAmount', async () => {
    await sendTabWith('1e3');
    expect(screen.queryByText('Claim Back Window')).toBeNull();
    fireEvent.change(document.getElementById('cashier-send-amount')!, {
      target: { value: '1000' },
    });
    expect(await screen.findByText('Claim Back Window')).toBeInTheDocument();
    expect(CLASSIC).not.toContain('parseFloat(amount) > 0');
    expect(CLASSIC).not.toContain('chipFigure(parseFloat(amount))');
    expect(CLASSIC).toContain('const typedAmount = parseChipAmount(amount);');
    expect(CLASSIC).toContain(
      "`Distribute ${typedChips !== null ? chipFigure(typedChips) : '0'} Chips`"
    );
  });

  // ── S-03 ─────────────────────────────────────────────────────────────────
  it('S-03: the Mint tab mints through fn_mint_chips_from_diamonds with one p_op_id per attempt', async () => {
    mintResponses.push(
      { data: null, error: { message: 'network lost' } },
      { data: { success: false, error: 'Mint Refused By The Economy Cap' }, error: null },
      { data: { success: true, replayed: false, scope: 'club', chips: 100 }, error: null }
    );
    start();
    await screen.findByRole('tab', { name: 'Mint' });
    fireEvent.click(screen.getByRole('tab', { name: 'Mint' }));
    const field = document.getElementById('cashier-amount') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '100' } });
    await screen.findByText(/Diamonds Required/);
    const confirm = () => screen.getByRole('button', { name: 'Confirm Mint' });
    const mintCalls = () => rpcCalls.filter(([name]) => name === 'fn_mint_chips_from_diamonds');
    const settled = async (count: number) => {
      await waitFor(() => expect(mintCalls()).toHaveLength(count));
      await waitFor(() => expect(confirm()).not.toBeDisabled());
    };

    // Attempt 1: the response is lost. The amount stays on screen for the retry.
    fireEvent.click(confirm());
    await settled(1);
    expect(field.value).toBe('100');
    // Attempt 2: refused by the server with a reason.
    nowMs += 5_000;
    fireEvent.click(confirm());
    await settled(2);
    await screen.findByText(/Mint Refused By The Economy Cap/);
    expect(field.value).toBe('100');
    // Attempt 3: lands.
    nowMs += 5_000;
    fireEvent.click(confirm());
    await screen.findByText(/Minted 100 Chips Into The Club Bank/);

    const mints = rpcCalls.filter(([name]) => name === 'fn_mint_chips_from_diamonds');
    expect(mints).toHaveLength(3);
    const keys = mints.map(([, args]) => String(args.p_op_id));
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(new Set(keys).size).toBe(1);
    for (const [, args] of mints) {
      expect(args.p_club_id).toBe(CLUB);
      expect(args.p_diamonds).toBe(100 * MINT_RATE);
    }
    // No call went through the World Hub route.
    expect(rpcCalls.some(([name]) => name === 'mint_club_chips')).toBe(false);
  }, 15_000);

  it('S-03: changing the amount is a new intent with a new p_op_id', async () => {
    mintResponses.push(
      { data: { success: false, error: 'Mint Refused' }, error: null },
      { data: { success: false, error: 'Mint Refused' }, error: null }
    );
    start();
    await screen.findByRole('tab', { name: 'Mint' });
    fireEvent.click(screen.getByRole('tab', { name: 'Mint' }));
    const field = document.getElementById('cashier-amount') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Mint' }));
    await screen.findByText(/Mint Refused/);
    nowMs += 5_000;
    fireEvent.change(field, { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Mint' }));
    await waitFor(() =>
      expect(rpcCalls.filter(([name]) => name === 'fn_mint_chips_from_diamonds')).toHaveLength(2)
    );
    const [a, b] = rpcCalls.filter(([name]) => name === 'fn_mint_chips_from_diamonds');
    expect(a[1].p_op_id).not.toBe(b[1].p_op_id);
    expect(b[1].p_diamonds).toBe(200 * MINT_RATE);
  });

  it('S-03: the Mint field refuses fractions and a mint with no rate', async () => {
    start();
    await screen.findByRole('tab', { name: 'Mint' });
    fireEvent.click(screen.getByRole('tab', { name: 'Mint' }));
    const field = document.getElementById('cashier-amount') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Mint' }));
    await screen.findByText('Mint Whole Chips Only');
    expect(rpcCalls.some(([name]) => name === 'fn_mint_chips_from_diamonds')).toBe(false);
  });

  it('G-03: the Mint branch reads the field through parseWholeChipAmount', () => {
    expect(CLASSIC).toContain('const whole = parseWholeChipAmount(input);');
    expect(CLASSIC).not.toContain('WHOLE_CHIPS.test(input.trim())');
  });
});

// ── G-03: the Mint field's reader ────────────────────────────────────────────
describe('parseWholeChipAmount (regression review)', () => {
  it('reads conventional grouping as the classic parser does, then requires whole chips', () => {
    expect(parseWholeChipAmount('1,000')).toEqual({ ok: true, value: 1000 });
    expect(parseWholeChipAmount('1,234,567')).toEqual({ ok: true, value: 1234567 });
    expect(parseWholeChipAmount('250')).toEqual({ ok: true, value: 250 });
    for (const text of ['1.5', '100.00', '1,000.50']) {
      expect(parseWholeChipAmount(text)).toEqual({ ok: false, error: 'Mint Whole Chips Only' });
    }
  });

  it("refuses what parseChipAmount refuses, with parseChipAmount's own words", () => {
    for (const text of ['1e3', '1,0', '-5', '', '0']) {
      const whole = parseWholeChipAmount(text);
      const classic = parseChipAmount(text);
      expect(whole.ok).toBe(false);
      expect(classic.ok).toBe(false);
      if (!whole.ok && !classic.ok) expect(whole.error).toBe(classic.error);
    }
  });
});

// ── P-14 / P-20: the amount parser ───────────────────────────────────────────
describe('parseChipAmount (launch audit)', () => {
  it('refuses exponent notation: a billion chips is not four keystrokes', () => {
    expect(parseChipAmount('1e9').ok).toBe(false);
    expect(parseChipAmount('1E3').ok).toBe(false);
    expect(parseChipAmount('+5').ok).toBe(false);
    expect(parseChipAmount('.5').ok).toBe(false);
    expect(parseChipAmount('0x10').ok).toBe(false);
  });

  it('accepts every two-decimal amount the ledger column holds, float rounding or not', () => {
    // Math.round(1.1 * 100) !== 1.1 * 100 in IEEE-754; the rule is on the spelling now.
    expect(parseChipAmount('1.10')).toEqual({ ok: true, value: 1.1 });
    expect(parseChipAmount('0.07')).toEqual({ ok: true, value: 0.07 });
    expect(parseChipAmount('0.55')).toEqual({ ok: true, value: 0.55 });
    expect(parseChipAmount('1.15')).toEqual({ ok: true, value: 1.15 });
    const three = parseChipAmount('1.234');
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.error).toMatch(/two decimal places/i);
  });

  it('reads conventional thousands grouping and names any other comma', () => {
    expect(parseChipAmount('1,000')).toEqual({ ok: true, value: 1000 });
    expect(parseChipAmount('1,234,567.89')).toEqual({ ok: true, value: 1234567.89 });
    const odd = parseChipAmount('1,0');
    expect(odd.ok).toBe(false);
    if (!odd.ok) expect(odd.error).toBe('Enter The Amount Without Commas');
    const decimalComma = parseChipAmount('1,5');
    expect(decimalComma.ok).toBe(false);
  });
});
