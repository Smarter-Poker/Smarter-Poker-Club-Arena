/**
 * THE VIP REWARDS SHOP ANNOUNCED SALES THAT NEVER HAPPENED.
 *
 * `handleRedeem` was, in full:
 *
 *     await new Promise((resolve) => setTimeout(resolve, 800));  // fake work
 *     if (onRedeem) { onRedeem(reward); }                        // NOT awaited
 *     toast.success(`Successfully redeemed ${reward.name}!`);    // always
 *
 * `onRedeem` is async and performs the actual spend. Not awaiting it meant the
 * success toast fired while the RPC was still in flight, and fired again — as
 * a success — when the RPC had REFUSED. VIPPage's own "Not enough VIP points"
 * error landed beside it, for the same click, on the same screen.
 *
 * These pin the contract: this component performs no redemption and therefore
 * makes no claim about one. The handler that talks to the server owns the
 * outcome message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const success = vi.fn();
const error = vi.fn();
vi.mock('../src/components/common/Toast', () => ({
  useToast: () => ({ success, error, show: vi.fn(), info: vi.fn() }),
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAIT FOR THE CATALOG, NOT FOR A NAME THE FALLBACK ALSO HAS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-29. Every case in this file used to open with
 * `await screen.findByText('Neon Table Theme')`, and the bundled fallback list
 * contains a reward by that exact name. `RewardsMarketplace` initialises
 * `rewards` to `null` and renders `rewards ?? FALLBACK_REWARDS`, so the FIRST
 * paint is the whole bundled catalog — featured banner and eight Redeem
 * buttons — before the mocked query has resolved. The `findByText` matched that
 * first paint and returned immediately, so the assertions ran against the
 * fallback rather than against the catalog under test.
 *
 * It passed on a laptop because the mocked promise resolves within the same
 * microtask queue as the first paint. On the 2-core CI runner it did not, and
 * `will not spend points the member does not have` failed with "Found multiple
 * elements with the role button and name /^Redeem$/" — eight of them, which is
 * the fallback list, named exactly what the harness had been told to wait for.
 *
 * The row the catalog serves is therefore given a name the fallback does NOT
 * have. Waiting for it is now real proof the query landed. The one case that
 * deliberately exercises the fallback still waits on the bundled name, which is
 * correct there and only there.
 */
const CATALOG_ONLY_NAME = 'Catalog Neon Theme';

/** The catalog read. Resolves empty so the bundled fallback list renders. */
const catalogRows: { data: unknown; error: unknown } = { data: [], error: null };
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve(catalogRows) }) }),
    }),
  },
}));

const { RewardsMarketplace } = await import('../src/components/vip/RewardsMarketplace');

beforeEach(() => {
  success.mockReset();
  error.mockReset();
  catalogRows.data = [
    {
      id: 'theme-neon',
      name: CATALOG_ONLY_NAME,
      description: 'Vibrant neon-style table theme',
      category: 'theme',
      points_cost: 2000,
      stock: null,
      featured: false,
      grant_type: 'theme',
    },
  ];
  catalogRows.error = null;
});

const clickRedeem = () => fireEvent.click(screen.getAllByRole('button', { name: /^Redeem$/ })[0]);

describe('RewardsMarketplace redemption', () => {
  it('says nothing about success on its own — the handler owns the outcome', async () => {
    const onRedeem = vi.fn().mockResolvedValue(undefined);
    render(<RewardsMarketplace currentPoints={9000} onRedeem={onRedeem} />);
    await screen.findByText(CATALOG_ONLY_NAME);
    clickRedeem();
    await waitFor(() => expect(onRedeem).toHaveBeenCalledTimes(1));
    // THE ORIGINAL BUG: `Successfully redeemed Neon Table Theme!` fired here.
    await waitFor(() => expect(success).not.toHaveBeenCalled());
  });

  it('does NOT announce a redemption the server refused', async () => {
    // The refusal path: the handler reports the refusal itself and resolves,
    // exactly as VIPPage does. Nothing here may add a success on top.
    const onRedeem = vi.fn().mockImplementation(async () => {
      error('Not Enough VIP Points For This Reward.');
    });
    render(<RewardsMarketplace currentPoints={9000} onRedeem={onRedeem} />);
    await screen.findByText(CATALOG_ONLY_NAME);
    clickRedeem();
    await waitFor(() => expect(onRedeem).toHaveBeenCalled());
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('awaits the redemption instead of racing it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const onRedeem = vi.fn().mockReturnValue(gate);
    render(<RewardsMarketplace currentPoints={9000} onRedeem={onRedeem} />);
    await screen.findByText(CATALOG_ONLY_NAME);
    clickRedeem();
    await waitFor(() => expect(onRedeem).toHaveBeenCalled());
    // While the server has not answered, the button stays busy.
    await waitFor(() => expect(screen.getByRole('button', { name: '...' })).toBeTruthy());
    release();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Redeem$/ })[0]).toBeTruthy()
    );
  });

  it('surfaces a thrown redemption as an error, not a success', async () => {
    const onRedeem = vi.fn().mockRejectedValue(new Error('Redemption Failed'));
    render(<RewardsMarketplace currentPoints={9000} onRedeem={onRedeem} />);
    await screen.findByText(CATALOG_ONLY_NAME);
    clickRedeem();
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(success).not.toHaveBeenCalled();
  });

  it('refuses to redeem at all when nothing can perform the redemption', async () => {
    render(<RewardsMarketplace currentPoints={9000} />);
    await screen.findByText(CATALOG_ONLY_NAME);
    clickRedeem();
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(success).not.toHaveBeenCalled();
    // Said in words a member can act on, not as a stray TypeError from
    // calling an undefined handler.
    expect(String(error.mock.calls[0][0])).toBe('Redeeming Is Not Available Right Now.');
  });

  it('takes the price from the server catalog, not the bundled copy', async () => {
    // The bundled fallback says 2,000 for theme-neon. If the catalog says
    // something else, the catalog is what a member sees.
    catalogRows.data = [
      {
        id: 'theme-neon',
        name: CATALOG_ONLY_NAME,
        description: 'x',
        category: 'theme',
        points_cost: 3300,
        stock: null,
        featured: false,
        grant_type: 'theme',
      },
    ];
    render(<RewardsMarketplace currentPoints={9000} onRedeem={vi.fn()} />);
    expect(await screen.findByText('3,300 Pts')).toBeTruthy();
  });

  it('does not call a failed catalog read an empty category', async () => {
    catalogRows.data = null;
    catalogRows.error = { message: 'rls denied' };
    render(<RewardsMarketplace currentPoints={9000} onRedeem={vi.fn()} />);
    // Falls back to the bundled list rather than an empty shop, and every
    // bundled auto-delivered reward is still shown.
    expect(await screen.findByText('Neon Table Theme')).toBeTruthy();
    expect(screen.getAllByText('Gold Avatar Frame').length).toBeGreaterThan(0);
  });

  it('will not spend points the member does not have', async () => {
    const onRedeem = vi.fn();
    render(<RewardsMarketplace currentPoints={10} onRedeem={onRedeem} />);
    await screen.findByText(CATALOG_ONLY_NAME);
    /* Exactly one, and it is the catalog's. This count is the assertion that
       caught the harness bug above: eight buttons here meant the test was
       looking at the bundled fallback, not at the row it had set up. */
    const buttons = screen.getAllByRole('button', { name: /^Redeem$/ }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(1);
    // The button is disabled, so no redemption can even be attempted.
    expect(buttons[0].disabled).toBe(true);
    expect(onRedeem).not.toHaveBeenCalled();
  });
});
