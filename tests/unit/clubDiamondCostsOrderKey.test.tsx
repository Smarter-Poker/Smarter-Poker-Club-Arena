/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE ORDER KEY PER QUOTE, AND NEVER A BLIND SECOND CHARGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Club And Union Diamond Costs page (R2 3.3, 7.2) owns three promises the
 * server cannot keep for it:
 *
 *   - a retry of the SAME quote sends the SAME order key, so the server
 *     replays the original receipt instead of charging again;
 *   - a NEW quote gets a NEW key;
 *   - when the connection drops mid purchase the page re-reads the receipts on
 *     file and, until it knows, offers only a retry of that same order (a new
 *     quote after an unseen commit would buy the following period).
 *
 * A double tap on Pay sends one purchase. The real ClubCommerceService runs
 * against a fake `supabase.rpc`, so the keys asserted here are the ones the
 * browser would put on the wire.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB = '0c1ab000-0000-4000-8000-000000000001';
const OWNER = '0a0e0000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  navigate: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: OWNER } }) }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: CLUB }),
  useNavigate: () => h.navigate,
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  isUUID: () => true,
  resolveClubUUIDStrict: async (id: string) => id,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, plates, title, id, tabIndex }: any) => (
    <section id={id} tabIndex={tabIndex} aria-label={title}>
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

const product = (sku: string, capacity: number, diamonds: number) => ({
  sku,
  title: `Up To ${capacity} Approved Members`,
  kind: 'capacity',
  scope_kind: 'club',
  term_kind: 'period',
  term_hours: 720,
  report_days: null,
  capacity,
  quantity_unit: 'flat',
  supported: true,
  included_note: 'Ordinary Administration',
  price: {
    price_version_id: `pv-${sku}`,
    version: 1,
    diamonds,
    price_rule: 'flat',
    cap_diamonds: null,
    price_authority: 'test',
    comparison_verified: false,
    effective_from: iso(now - 1000),
  },
});

type Server = {
  quotes: number;
  purchase: (args: Record<string, unknown>) => { data: unknown; error: unknown };
  receipts: () => unknown[];
};
let server: Server;

function receiptFor(quoteId: string, replay = false) {
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
    scope_id: CLUB,
    kind: 'purchase',
    diamond_tx_id: 'tx',
    mint_op_id: 'op',
    catalog_version: 'catalog:1',
    delivery_status: 'delivered',
    entitlement_status: 'effective',
    committed_at: iso(now),
    lines: [],
  };
}

beforeEach(() => {
  server = {
    quotes: 0,
    purchase: (args) => ({ data: receiptFor(String(args.p_quote_id)), error: null }),
    receipts: () => [],
  };
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    switch (fn) {
      case 'fn_ca_commerce_scope_status':
        return {
          data: {
            success: true,
            server_time: iso(Date.now()),
            role: 'owner',
            scope_kind: 'club',
            scope_id: CLUB,
            owner_id: OWNER,
            policy_version: 'v1',
            checkout_enabled: true,
            admission_enforced_from: null,
            roster_count: 40,
            covered_club_count: null,
            trial: null,
            entitlements: [],
            sponsorships: [],
            balance: 5000,
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
            products: [product('capacity_60', 60, 400), product('capacity_100', 100, 700)],
          },
          error: null,
        };
      case 'fn_ca_commerce_receipts':
        return { data: server.receipts(), error: null };
      case 'fn_ca_commerce_quote': {
        server.quotes += 1;
        const line = (args.p_lines as Array<{ sku: string }>)[0];
        return {
          data: {
            success: true,
            quote_id: `quote-${server.quotes}`,
            expires_at: iso(Date.now() + 15 * 60_000),
            catalog_version: 'catalog:1',
            payer_id: OWNER,
            sponsorship_id: null,
            purchase_kind: 'purchase',
            lines: [
              {
                index: 0,
                sku: line.sku,
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
            available_balance: 5000,
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

const purchaseCalls = () =>
  h.rpc.mock.calls.filter(([fn]) => fn === 'fn_ca_commerce_purchase').map(([, a]) => a);

async function quoteCapacity100() {
  render(<ClubDiamondCostsPage scopeKind="club" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Up To 100 Approved Members:/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Get A Quote' }));
  return screen.findByRole('button', { name: 'Pay 700 Diamonds' });
}

describe('Club And Union Diamond Costs: order keys', () => {
  it('a double tap on Pay sends exactly one purchase', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pay = await quoteCapacity100();
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'fn_ca_commerce_purchase') {
        await gate;
        return { data: receiptFor(String(args.p_quote_id)), error: null };
      }
      return original(fn, args);
    });
    fireEvent.click(pay);
    fireEvent.click(pay);
    await act(async () => release());
    await screen.findByText('Charged Now');
    expect(purchaseCalls()).toHaveLength(1);
  });

  it('retries an unknown outcome with the SAME key and blocks a new quote meanwhile', async () => {
    let attempt = 0;
    server.purchase = (args) => {
      attempt += 1;
      if (attempt === 1) return { data: null, error: { message: 'Failed to fetch' } };
      return { data: receiptFor(String(args.p_quote_id), true), error: null };
    };
    const pay = await quoteCapacity100();
    fireEvent.click(pay);

    const retry = await screen.findByRole('button', { name: 'Retry Same Order' });
    expect(screen.getByRole('button', { name: 'Get A Quote' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(purchaseCalls()).toHaveLength(2));
    const [first, second] = purchaseCalls();
    expect(second.p_quote_id).toBe(first.p_quote_id);
    expect(second.p_request_key).toBe(first.p_request_key);
    expect(String(first.p_request_key).length).toBeGreaterThanOrEqual(8);
    await screen.findByText('Charged On This Retry');
  });

  it('recovers a committed order from the receipts on file without paying again', async () => {
    server.purchase = () => ({ data: null, error: { message: 'Failed to fetch' } });
    server.receipts = () => [receiptFor('quote-1', true)];
    const pay = await quoteCapacity100();
    fireEvent.click(pay);
    await screen.findByText('Charged For This Order');
    expect(purchaseCalls()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Retry Same Order' })).toBeNull();
  });

  it('a new quote gets a new key', async () => {
    const pay = await quoteCapacity100();
    fireEvent.click(pay);
    await screen.findByText('Charged Now');
    fireEvent.click(screen.getByRole('button', { name: 'Get A Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pay 700 Diamonds' }));
    await waitFor(() => expect(purchaseCalls()).toHaveLength(2));
    const [first, second] = purchaseCalls();
    expect(second.p_quote_id).not.toBe(first.p_quote_id);
    expect(second.p_request_key).not.toBe(first.p_request_key);
  });

  it('changing the selection retires the quote on screen', async () => {
    await quoteCapacity100();
    fireEvent.click(screen.getByRole('button', { name: /^Up To 60 Approved Members:/ }));
    expect(screen.queryByRole('button', { name: 'Pay 700 Diamonds' })).toBeNull();
  });
});
