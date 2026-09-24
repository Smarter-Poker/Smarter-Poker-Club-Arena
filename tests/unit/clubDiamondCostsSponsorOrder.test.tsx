/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A UNION SPONSOR BUYS CAPACITY FOR A COVERED CLUB, ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On /unions/:unionId/diamond-costs the payer of an active sponsorship gets a
 * "Buy For A Covered Club" console. It quotes a CLUB order paid by the
 * sponsorship - fn_ca_commerce_quote('club', club, lines, sponsorship, NULL,
 * 'purchase') - and confirms it under the same order key rules as every other
 * order on the page: one key per quote, the same key on a retry after an
 * unknown outcome. A club still in its free month is shown as such and never
 * offered for sale, including when the purchase itself is refused with
 * trial_active_authorize_instead. The union's receipt list carries the
 * sponsored club orders, named by club.
 *
 * The real ClubCommerceService runs against a fake `supabase.rpc`, so the
 * arguments asserted here are the ones the browser would send.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UNION = '0a100000-0000-4000-8000-000000000001';
const OWNER = '0a0e0000-0000-4000-8000-000000000001';
const OTHER = '0a0e0000-0000-4000-8000-000000000002';
const CLUB_A = '0c1ab000-0000-4000-8000-00000000000a';
const CLUB_B = '0c1ab000-0000-4000-8000-00000000000b';
const CLUB_X = '0c1ab000-0000-4000-8000-0000000000ff';
const SPONSORSHIP = '05005000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  navigate: vi.fn(),
  rpc: vi.fn(),
  viewer: { id: '' },
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: h.viewer }) }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ unionId: UNION }),
  useNavigate: () => h.navigate,
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  isUUID: () => true,
  resolveClubUUIDStrict: async (id: string) => id,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, plates, title, eyebrow, id, tabIndex }: any) => (
    <section id={id} tabIndex={tabIndex} aria-label={`${eyebrow ?? ''} ${title}`.trim()}>
      {children}
      {plates?.secondary ? (
        <button disabled={plates.secondary.disabled} onClick={plates.secondary.onClick}>
          {plates.secondary.label}
        </button>
      ) : null}
      {plates?.primary ? (
        <button disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      ) : null}
    </section>
  ),
}));

import ClubDiamondCostsPage from '../../src/pages/club/ClubDiamondCostsPage';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const capacity = (cap: number, diamonds: number) => ({
  sku: `capacity_${cap}`,
  title: `Up To ${cap} Approved Members`,
  kind: 'capacity',
  scope_kind: 'club',
  term_kind: 'period',
  term_hours: 720,
  report_days: null,
  capacity: cap,
  quantity_unit: 'flat',
  supported: true,
  included_note: 'Ordinary Administration',
  price: {
    price_version_id: `pv-${cap}`,
    version: 1,
    diamonds,
    price_rule: 'flat',
    cap_diamonds: null,
    price_authority: 'test',
    comparison_verified: false,
    effective_from: iso(now - 1000),
  },
});

function receiptFor(quoteId: string, scopeId: string, replay: boolean, sponsorshipId?: string) {
  return {
    success: true,
    purchase_id: `purchase-${quoteId}`,
    quote_id: quoteId,
    is_replay: replay,
    original_total_diamonds: 700,
    original_gross_diamonds: 700,
    trial_waiver: 0,
    charged_this_attempt: replay ? 0 : 700,
    payer_id: OWNER,
    scope_kind: 'club',
    scope_id: scopeId,
    kind: 'purchase',
    diamond_tx_id: 'tx',
    mint_op_id: 'op',
    catalog_version: 'catalog:1',
    delivery_status: 'delivered',
    entitlement_status: 'effective',
    committed_at: iso(now),
    lines: [],
    ...(sponsorshipId !== undefined ? { sponsorship_id: sponsorshipId } : {}),
  };
}

let server: {
  quotes: number;
  purchase: (args: Record<string, unknown>) => { data: unknown; error: unknown };
  receipts: () => unknown[];
  clubBTrial: boolean;
};

beforeEach(() => {
  h.viewer.id = OWNER;
  server = {
    quotes: 0,
    purchase: (args) => ({
      data: receiptFor(String(args.p_quote_id), CLUB_A, false, SPONSORSHIP),
      error: null,
    }),
    receipts: () => [],
    clubBTrial: true,
  };
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    switch (fn) {
      case 'fn_ca_commerce_scope_status':
        return {
          data: {
            success: true,
            server_time: iso(Date.now()),
            role: 'owner',
            scope_kind: 'union',
            scope_id: UNION,
            owner_id: OWNER,
            policy_version: 'v1',
            checkout_enabled: true,
            admission_enforced_from: null,
            roster_count: null,
            covered_club_count: 2,
            covered_clubs: [
              {
                club_id: CLUB_A,
                name: 'Aces High',
                roster_count: 80,
                trial_active: false,
                capacity: {
                  sku: 'capacity_60',
                  capacity: 60,
                  ends_at: iso(now + 86_400_000),
                  source: 'purchase',
                },
              },
              {
                club_id: CLUB_B,
                name: 'Blue River',
                roster_count: 10,
                trial_active: server.clubBTrial,
                capacity: null,
              },
            ],
            trial: null,
            entitlements: [],
            sponsorships: [
              {
                id: SPONSORSHIP,
                club_id: null,
                payer_id: OWNER,
                total_budget: 5000,
                per_club_budget: null,
                committed: 0,
                effective_from: iso(now - 86_400_000),
                effective_to: null,
                state: 'active',
                revision: 1,
              },
            ],
            balance: 9000,
          },
          error: null,
        };
      case 'fn_ca_commerce_catalog':
        return {
          data: {
            catalog_version: 'catalog:1',
            catalog_visible: true,
            checkout_enabled: true,
            nominal_cents_per_diamond: 1,
            products: args.p_scope_kind === 'club' ? [capacity(60, 400), capacity(100, 700)] : [],
          },
          error: null,
        };
      case 'fn_ca_commerce_receipts':
        return { data: server.receipts(), error: null };
      case 'fn_ca_commerce_quote': {
        server.quotes += 1;
        return {
          data: {
            success: true,
            quote_id: `quote-${server.quotes}`,
            expires_at: iso(Date.now() + 15 * 60_000),
            catalog_version: 'catalog:1',
            payer_id: OWNER,
            sponsorship_id: args.p_sponsorship_id,
            purchase_kind: 'purchase',
            lines: [
              {
                index: 0,
                sku: 'capacity_100',
                kind: 'capacity',
                title: 'Up To 100 Approved Members',
                price_version_id: 'pv',
                unit_diamonds: 700,
                quantity: 1,
                capacity: 100,
                term_hours: 720,
                starts_at: iso(now),
                ends_at: iso(now + 30 * 86_400_000),
                gross: 700,
                credit: 0,
                comparison_adjustment: 0,
                waiver: 0,
                net: 700,
                replaces_entitlement_id: null,
                included_note: '',
                comparison_verified: false,
              },
            ],
            gross: 700,
            credits: 0,
            comparison_adjustment: 0,
            trial_waiver: 0,
            net: 700,
            nominal_cents: 700,
            trial_active: false,
            trial_end: null,
            available_balance: 9000,
            renewal_max_diamonds: null,
          },
          error: null,
        };
      }
      case 'fn_ca_commerce_purchase':
        return server.purchase(args);
      default:
        return { data: { success: false, error: 'unexpected' }, error: null };
    }
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const calls = (name: string) =>
  h.rpc.mock.calls.filter(([fn]) => fn === name).map(([, a]) => a as Record<string, unknown>);

const sponsorConsole = () =>
  screen.getByRole('region', { name: 'Sponsorship Buy For A Covered Club' });

async function quoteForAcesHigh() {
  render(<ClubDiamondCostsPage scopeKind="union" />);
  const buy = await screen.findByRole('region', { name: 'Sponsorship Buy For A Covered Club' });
  fireEvent.click(within(buy).getByRole('button', { name: /^Aces High:/ }));
  fireEvent.click(
    within(sponsorConsole()).getByRole('button', { name: /^Up To 100 Approved Members:/ })
  );
  fireEvent.click(within(sponsorConsole()).getByRole('button', { name: 'Get A Quote' }));
  const quote = await screen.findByRole('region', { name: 'Sponsored Quote Confirm Your Order' });
  return within(quote).getByRole('button', { name: 'Pay 700 Diamonds' });
}

describe('Buy For A Covered Club: the sponsored order path', () => {
  it('quotes a club order paid by the sponsorship, with exactly the declared keys', async () => {
    await quoteForAcesHigh();
    const [q] = calls('fn_ca_commerce_quote');
    expect(q).toEqual({
      p_scope_kind: 'club',
      p_scope_id: CLUB_A,
      p_lines: [{ sku: 'capacity_100', quantity: 1 }],
      p_sponsorship_id: SPONSORSHIP,
      p_renewal_max_diamonds: null,
      p_purchase_kind: 'purchase',
    });
  });

  it('disables capacities below the club roster and flags a roster over capacity', async () => {
    render(<ClubDiamondCostsPage scopeKind="union" />);
    const buy = await screen.findByRole('region', { name: 'Sponsorship Buy For A Covered Club' });
    const aces = within(buy).getByRole('button', { name: /^Aces High:/ });
    expect(aces).toHaveAccessibleName('Aces High: Over Capacity');
    fireEvent.click(aces);
    expect(
      within(sponsorConsole()).getByRole('button', { name: /^Up To 60 Approved Members:/ })
    ).toBeDisabled();
    expect(
      within(sponsorConsole()).getByRole('button', { name: /^Up To 100 Approved Members:/ })
    ).toBeEnabled();
  });

  it('retries an unknown outcome with the SAME order key', async () => {
    let attempt = 0;
    server.purchase = (args) => {
      attempt += 1;
      if (attempt === 1) return { data: null, error: { message: 'Failed to fetch' } };
      return { data: receiptFor(String(args.p_quote_id), CLUB_A, true, SPONSORSHIP), error: null };
    };
    fireEvent.click(await quoteForAcesHigh());
    const retry = await screen.findByRole('button', { name: 'Retry Same Order' });
    expect(within(sponsorConsole()).getByRole('button', { name: 'Get A Quote' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(calls('fn_ca_commerce_purchase')).toHaveLength(2));
    const [first, second] = calls('fn_ca_commerce_purchase');
    expect(second.p_quote_id).toBe(first.p_quote_id);
    expect(second.p_request_key).toBe(first.p_request_key);
    const receipt = await screen.findByRole('region', { name: 'Receipt Order Complete' });
    expect(within(receipt).getByText('Charged On This Retry')).toBeInTheDocument();
    expect(within(receipt).getByText('Aces High')).toBeInTheDocument();
    /* Recovery searched every receipt of the sponsor, not the union scope. */
    expect(calls('fn_ca_commerce_receipts')).toContainEqual({
      p_scope_kind: null,
      p_scope_id: null,
    });
  });

  it('shows a club in its free month instead of offering to buy', async () => {
    render(<ClubDiamondCostsPage scopeKind="union" />);
    const buy = await screen.findByRole('region', { name: 'Sponsorship Buy For A Covered Club' });
    fireEvent.click(within(buy).getByRole('button', { name: /^Blue River:/ }));
    expect(within(sponsorConsole()).getByText('Club In Its Free Month')).toBeInTheDocument();
    expect(
      within(sponsorConsole()).queryByRole('button', { name: /Approved Members:/ })
    ).toBeNull();
    expect(within(sponsorConsole()).getByRole('button', { name: 'Get A Quote' })).toBeDisabled();
  });

  it('turns a trial refusal at purchase into the free month state, charging nothing', async () => {
    server.purchase = () => ({
      data: {
        success: false,
        error: 'trial_active_authorize_instead',
        trial_end: iso(now + 5 * 86_400_000),
      },
      error: null,
    });
    fireEvent.click(await quoteForAcesHigh());
    await waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(
        'This Club Is Still In Its Free Month. Nothing Was Charged'
      )
    );
    expect(screen.queryByRole('region', { name: 'Sponsored Quote Confirm Your Order' })).toBeNull();
    expect(within(sponsorConsole()).getByText('Club In Its Free Month')).toBeInTheDocument();
  });

  it('lists sponsored club receipts by club name and leaves out unrelated ones', async () => {
    server.receipts = () => [
      receiptFor('q-sponsored', CLUB_A, true, SPONSORSHIP),
      receiptFor('q-elsewhere', CLUB_X, true, SPONSORSHIP),
      receiptFor('q-own-club', CLUB_B, true, null as unknown as string),
    ];
    render(<ClubDiamondCostsPage scopeKind="union" />);
    const records = await screen.findByRole('region', { name: 'Records Receipts' });
    await waitFor(() =>
      expect(within(records).getByText(/Sponsored For Aces High\./)).toBeInTheDocument()
    );
    expect(within(records).getAllByText(/^Order /)).toHaveLength(1);
  });

  it('is not offered to a viewer who does not pay a sponsorship', async () => {
    h.viewer.id = OTHER;
    render(<ClubDiamondCostsPage scopeKind="union" />);
    await screen.findByRole('region', { name: 'Records Receipts' });
    expect(screen.queryByRole('region', { name: 'Sponsorship Buy For A Covered Club' })).toBeNull();
  });
});
