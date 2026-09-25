/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SPONSOR RENEWS WHAT THEIR SPONSORSHIP PAID FOR, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 20260924102040 lets a union sponsor authorize or cancel the renewal of a
 * club right their sponsorship paid for (fn_ca_commerce_set_renewal's
 * sponsor path); the renewal is charged to the sponsor within that
 * sponsorship. On the union page each such right, read from the sponsor's own
 * receipts (rights[]), carries the same ceiling rules as an owner renewal: a
 * whole number at or above today's price, and the exact sentence the sponsor
 * accepts. A right the sponsor did not pay for is never offered.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UNION = '0a100000-0000-4000-8000-000000000001';
const OWNER = '0a0e0000-0000-4000-8000-000000000001';
const OTHER = '0a0e0000-0000-4000-8000-000000000002';
const CLUB_A = '0c1ab000-0000-4000-8000-00000000000a';
const SPONSORSHIP = '05005000-0000-4000-8000-000000000001';
const ENT = '0e0e0000-0000-4000-8000-00000000000a';

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
  useParams: () => ({ unionId: UNION }),
  useNavigate: () => h.navigate,
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  isUUID: () => true,
  resolveClubUUIDStrict: async (id: string) => id,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, plates, title, eyebrow }: any) => (
    <section aria-label={`${eyebrow ?? ''} ${title}`.trim()}>
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
const DAY = 86_400_000;
const ACCEPTED =
  'I Authorize Club Arena To Renew Up To 100 Approved Members For Up To 800 Diamonds Per Period, Paid From My Diamond Balance Within My Sponsorship Budget, Until I Cancel.';

let renewal: Record<string, unknown> | null;
let payer: string;

function sponsoredReceipt() {
  return {
    success: true,
    purchase_id: '0b0b0000-0000-4000-8000-00000000000a',
    quote_id: 'q-a',
    is_replay: true,
    original_total_diamonds: 700,
    original_gross_diamonds: 700,
    trial_waiver: 0,
    charged_this_attempt: 0,
    payer_id: payer,
    scope_kind: 'club',
    scope_id: CLUB_A,
    sponsorship_id: SPONSORSHIP,
    kind: 'purchase',
    diamond_tx_id: 'tx',
    mint_op_id: 'op',
    catalog_version: 'catalog:1',
    delivery_status: 'delivered',
    entitlement_status: 'effective',
    committed_at: iso(now - 10 * DAY),
    lines: [
      {
        index: 0,
        sku: 'capacity_100',
        kind: 'capacity',
        title: 'Up To 100 Approved Members',
        price_version_id: 'pv-100',
        unit_diamonds: 700,
        quantity: 1,
        capacity: 100,
        term_hours: 720,
        starts_at: iso(now - 10 * DAY),
        ends_at: iso(now + 20 * DAY),
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
    refunds: [],
    refund_requests: [],
    rights: [
      {
        entitlement_id: ENT,
        line_index: 0,
        sku: 'capacity_100',
        state: 'effective',
        starts_at: iso(now - 10 * DAY),
        ends_at: iso(now + 20 * DAY),
        refundable: 700,
        renewal,
      },
    ],
  };
}

beforeEach(() => {
  renewal = null;
  payer = OWNER;
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
            covered_club_count: 1,
            covered_clubs: [
              {
                club_id: CLUB_A,
                name: 'Aces High',
                roster_count: 80,
                trial_active: false,
                capacity: {
                  entitlement_id: ENT,
                  sku: 'capacity_100',
                  capacity: 100,
                  ends_at: iso(now + 20 * DAY),
                  source: 'sponsor',
                  renewal: null,
                },
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
                committed: 700,
                effective_from: iso(now - 20 * DAY),
                effective_to: null,
                state: 'active',
                revision: 1,
              },
            ],
            balance: 9000,
            balance_breakdown: {
              available: 9000,
              reserved: 0,
              pending_refunds: 0,
              owed_refunds: 0,
            },
            refund_requests: [],
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
            products:
              args.p_scope_kind === 'club'
                ? [
                    {
                      sku: 'capacity_100',
                      title: 'Up To 100 Approved Members',
                      kind: 'capacity',
                      scope_kind: 'club',
                      term_kind: 'period',
                      term_hours: 720,
                      report_days: null,
                      capacity: 100,
                      quantity_unit: 'flat',
                      supported: true,
                      included_note: '',
                      price: {
                        price_version_id: 'pv-100',
                        version: 1,
                        diamonds: 700,
                        price_rule: 'flat',
                        cap_diamonds: null,
                        price_authority: 'test',
                        comparison_verified: false,
                        effective_from: iso(now - DAY),
                      },
                    },
                  ]
                : [],
          },
          error: null,
        };
      case 'fn_ca_commerce_receipts':
        return { data: [sponsoredReceipt()], error: null };
      case 'fn_ca_commerce_policies':
        return {
          data: {
            success: true,
            policies: [
              {
                policy_id: 'c1',
                kind: 'renewal_ceiling',
                version: 1,
                title: 'Renewal Authorization',
                body: 'I Authorize Club Arena To Renew {product} For Up To {ceiling} Diamonds Per Period, Paid From {payer}, Until I Cancel.',
                effective_from: iso(now - DAY),
                current: true,
              },
              {
                policy_id: 't1',
                kind: 'renewal_terms',
                version: 1,
                title: 'Renewal Terms',
                body: 'Terms.',
                effective_from: iso(now - DAY),
                current: true,
              },
            ],
          },
          error: null,
        };
      case 'fn_ca_commerce_set_renewal':
        if (args.p_enabled) {
          renewal = {
            mandate_id: 'm-a',
            state: 'authorized',
            sku: 'capacity_100',
            quantity: 1,
            max_diamonds: args.p_max_diamonds,
            due_at: iso(now + 20 * DAY),
            sponsorship_id: SPONSORSHIP,
          };
          return {
            data: {
              success: true,
              mandate_id: 'm-a',
              state: 'authorized',
              sku: 'capacity_100',
              max_diamonds: args.p_max_diamonds,
              due_at: iso(now + 20 * DAY),
              payer_id: OWNER,
              sponsorship_id: SPONSORSHIP,
              terms_version: 1,
              ceiling_text_version: 1,
              accepted_ceiling_text: ACCEPTED,
            },
            error: null,
          };
        }
        renewal = renewal ? { ...renewal, state: 'cancelled' } : null;
        return {
          data: { success: true, mandate_id: 'm-a', state: 'cancelled', sku: 'capacity_100' },
          error: null,
        };
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

const renewals = () => screen.getByRole('region', { name: 'Sponsorship Renewals' });

describe('Sponsored renewals on the union page', () => {
  it('refuses a ceiling below the current price before asking the server', async () => {
    render(<ClubDiamondCostsPage scopeKind="union" />);
    const box = await screen.findByRole('region', { name: 'Sponsorship Renewals' });
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: '500' } });
    fireEvent.click(within(box).getByRole('button', { name: /^Authorize Sponsored Renewal:/ }));
    expect(h.toast.error).toHaveBeenCalledWith(
      "Set A Ceiling Of At Least 700 Diamonds, Today's Price"
    );
    expect(calls('fn_ca_commerce_set_renewal')).toHaveLength(0);
  });

  it('authorizes with a ceiling, shows the accepted sentence, and cancels', async () => {
    render(<ClubDiamondCostsPage scopeKind="union" />);
    const box = await screen.findByRole('region', { name: 'Sponsorship Renewals' });
    expect(
      within(box).getByText(/Paid From My Diamond Balance Within My Sponsorship Budget/)
    ).toBeInTheDocument();
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: '800' } });
    fireEvent.click(within(box).getByRole('button', { name: /^Authorize Sponsored Renewal:/ }));
    await waitFor(() => expect(calls('fn_ca_commerce_set_renewal')).toHaveLength(1));
    expect(calls('fn_ca_commerce_set_renewal')[0]).toEqual({
      p_entitlement_id: ENT,
      p_enabled: true,
      p_max_diamonds: 800,
      p_sku: null,
      p_quantity: null,
    });
    const cancel = await within(renewals()).findByRole('button', {
      name: /^Cancel Sponsored Renewal:/,
    });
    expect(
      within(renewals()).getByText(/You Accepted: "I Authorize Club Arena/)
    ).toBeInTheDocument();
    fireEvent.click(cancel);
    await waitFor(() => expect(calls('fn_ca_commerce_set_renewal')).toHaveLength(2));
    expect(calls('fn_ca_commerce_set_renewal')[1]).toEqual({
      p_entitlement_id: ENT,
      p_enabled: false,
      p_max_diamonds: null,
      p_sku: null,
      p_quantity: null,
    });
  });

  it('never offers a right the viewer did not pay for', async () => {
    payer = OTHER;
    render(<ClubDiamondCostsPage scopeKind="union" />);
    await screen.findByRole('region', { name: 'Records Receipts' });
    expect(screen.queryByRole('region', { name: 'Sponsorship Renewals' })).toBeNull();
  });
});
