/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DIAMOND COSTS: THE CATALOG SWITCH, TERMS, FREE MONTH, WRITTEN QUOTES,
 *  REVIEWS, SPONSORED INSURANCE AND SETTLED EARNINGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The owner's page against the doors of 20260924182605 and 20260924183657:
 *   - a catalog that is not published lists no prices and quotes nothing;
 *   - quote refusals (rate_limited, catalog_not_visible) read in words;
 *   - a quote that says the owner never had a free month offers it beside the
 *     purchase, which stays payable;
 *   - the Operating Service Terms version is named where it is accepted and
 *     its text opens on request;
 *   - written quotes above 2,500 members: ask, withdraw, and buy an offer
 *     through the normal order;
 *   - a free month review is offered once the scope's free month has ended;
 *   - a union sponsor is offered the club insurance module only when the
 *     platform says it is available;
 *   - settled earnings beside operating purchases, for the owner only.
 *
 * The real ClubCommerceService runs against a fake `supabase.rpc` that
 * answers in the migrations' own JSON shapes.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB = '0c1ab000-0000-4000-8000-000000000001';
const UNION = '0a100000-0000-4000-8000-000000000001';
const COVERED = '0c1ab000-0000-4000-8000-00000000000a';
const OWNER = '0a0e0000-0000-4000-8000-000000000001';
const SPONSORSHIP = '05005000-0000-4000-8000-000000000001';
const WQ_OPEN = '0d0d0000-0000-4000-8000-000000000001';
const WQ_OFFER = '0d0d0000-0000-4000-8000-000000000002';
const WQ_OLD = '0d0d0000-0000-4000-8000-000000000003';

const h = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  navigate: vi.fn(),
  rpc: vi.fn(),
  params: {} as Record<string, string>,
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: OWNER } }) }));
vi.mock('react-router-dom', () => ({
  useParams: () => h.params,
  useNavigate: () => h.navigate,
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  isUUID: () => true,
  resolveClubUUIDStrict: async (id: string) => id,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, plates, title, eyebrow, pill, id, tabIndex }: any) => (
    <section
      id={id}
      tabIndex={tabIndex}
      aria-label={`${eyebrow ?? ''} ${title}`.trim()}
      data-pill={pill ?? ''}
    >
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

const price = (diamonds: number) => ({
  price_version_id: `pv-${diamonds}`,
  version: 1,
  diamonds,
  price_rule: 'flat',
  cap_diamonds: null,
  price_authority: 'test',
  comparison_verified: false,
  effective_from: iso(now - DAY),
});

const capacity = (cap: number, diamonds: number | null) => ({
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
  platform_capability_id: null,
  platform_available: null,
  price: diamonds === null ? null : price(diamonds),
});

const insurance = (available: boolean, priced = true) => ({
  sku: 'club_insurance_module',
  title: 'Club Insurance Software Module',
  kind: 'club_insurance_module',
  scope_kind: 'club',
  term_kind: 'period',
  term_hours: 720,
  report_days: null,
  capacity: null,
  quantity_unit: 'flat',
  supported: true,
  included_note:
    'Insurance Software Access For One Club; Premiums, Odds And Accepted Payouts Are Unchanged',
  platform_capability_id: 'cash.insurance_ev_cashout',
  platform_available: available,
  price: priced ? price(200) : null,
});

const POLICIES = [
  {
    policy_id: 'pol-r1',
    kind: 'refund',
    version: 1,
    title: 'Refund Policy',
    body: 'Refunds Are Decided By Platform Staff.',
    effective_from: iso(now - 30 * DAY),
    current: true,
  },
  {
    policy_id: 'pol-s1',
    kind: 'service_terms',
    version: 1,
    title: 'Operating Service Terms',
    body: 'Operating Services Are Software Services For Running A Club Or Union.',
    effective_from: iso(now - 2 * DAY),
    current: true,
  },
];

function quoteFor(sku: string, net: number, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    quote_id: `quote-${sku}`,
    expires_at: iso(Date.now() + 15 * 60_000),
    catalog_version: 'catalog:1',
    payer_id: OWNER,
    sponsorship_id: null,
    purchase_kind: 'purchase',
    lines: [
      {
        index: 0,
        sku,
        kind: 'capacity',
        title: sku === 'capacity_60' ? 'Up To 60 Approved Members' : 'Up To 3,000 Approved Members',
        price_version_id: 'pv',
        unit_diamonds: net,
        quantity: 1,
        capacity: 60,
        term_hours: 720,
        starts_at: iso(now),
        ends_at: iso(now + 30 * DAY),
        gross: net,
        credit: 0,
        comparison_adjustment: 0,
        waiver: 0,
        net,
        replaces_entitlement_id: null,
        included_note: '',
        comparison_verified: false,
      },
    ],
    gross: net,
    credits: 0,
    comparison_adjustment: 0,
    trial_waiver: 0,
    net,
    nominal_cents: net,
    trial_active: false,
    trial_end: null,
    available_balance: 20000,
    renewal_max_diamonds: null,
    ...extra,
  };
}

const writtenQuote = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  written_quote_id: id,
  scope_kind: 'club',
  scope_id: CLUB,
  requested_by: OWNER,
  requested_capacity: 3000,
  request_note: null,
  state,
  offered_capacity: null,
  offered_diamonds: null,
  sku: null,
  price_version_id: null,
  valid_until: null,
  decided_by: null,
  decided_at: null,
  staff_note: null,
  created_at: iso(now - DAY),
  ...extra,
});

type Server = {
  role: 'owner' | 'admin';
  scopeKind: 'club' | 'union';
  visible: boolean;
  trial: null | { trial_end: string; active: boolean };
  quote: (args: Record<string, unknown>) => unknown;
  written: unknown[];
  reviews: unknown[];
  earnings: unknown;
  insuranceAvailable: boolean;
  write: (fn: string, args: Record<string, unknown>) => unknown;
};
let server: Server;

function statusFor() {
  const trial = server.trial
    ? {
        trial_id: 'trial-1',
        trial_start: iso(Date.parse(server.trial.trial_end) - 30 * DAY),
        trial_end: server.trial.trial_end,
        cohort: 'new_operator',
        active: server.trial.active,
      }
    : null;
  return {
    success: true,
    server_time: iso(Date.now()),
    role: server.role,
    scope_kind: server.scopeKind,
    scope_id: server.scopeKind === 'club' ? CLUB : UNION,
    owner_id: OWNER,
    policy_version: 'v1',
    checkout_enabled: true,
    admission_enforced_from: null,
    roster_count: server.scopeKind === 'club' ? 12 : null,
    covered_club_count: server.scopeKind === 'union' ? 1 : null,
    covered_clubs:
      server.scopeKind === 'union'
        ? [
            {
              club_id: COVERED,
              name: 'Aces High',
              roster_count: 20,
              trial_active: false,
              capacity: null,
            },
          ]
        : [],
    trial,
    entitlements: [],
    sponsorships:
      server.scopeKind === 'union'
        ? [
            {
              id: SPONSORSHIP,
              club_id: null,
              payer_id: OWNER,
              total_budget: 5000,
              per_club_budget: null,
              committed: 0,
              effective_from: iso(now - DAY),
              effective_to: null,
              state: 'active',
              revision: 1,
            },
          ]
        : [],
    balance: 20000,
  };
}

beforeEach(() => {
  h.params = { clubId: CLUB };
  server = {
    role: 'owner',
    scopeKind: 'club',
    visible: true,
    trial: null,
    quote: (args) => quoteFor(String((args.p_lines as Array<{ sku: string }>)[0].sku), 500),
    written: [],
    reviews: [],
    earnings: { success: false, error: 'owner_required' },
    insuranceAvailable: true,
    write: () => ({ success: true }),
  };
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    const ok = (data: unknown) => ({ data, error: null });
    switch (fn) {
      case 'fn_ca_commerce_scope_status':
        return ok(statusFor());
      case 'fn_ca_commerce_catalog': {
        const club = args.p_scope_kind === 'club';
        const products = club
          ? [
              capacity(60, server.visible ? 500 : null),
              capacity(2500, server.visible ? 7000 : null),
              insurance(server.insuranceAvailable, server.visible),
            ]
          : [];
        return ok({
          catalog_version: 'catalog:20260924T100000:abc',
          catalog_visible: server.visible,
          checkout_enabled: true,
          nominal_cents_per_diamond: 1,
          service_terms_version: 1,
          products,
        });
      }
      case 'fn_ca_commerce_receipts':
        return ok([]);
      case 'fn_ca_commerce_policies':
        return ok({ success: true, policies: POLICIES });
      case 'fn_ca_commerce_written_quotes':
        return ok({ success: true, written_quotes: server.written });
      case 'fn_ca_commerce_trial_reviews':
        return ok({ success: true, reviews: server.reviews });
      case 'fn_ca_commerce_earnings_coverage':
        return ok(server.earnings);
      case 'fn_ca_commerce_quote':
        return ok(server.quote(args));
      default:
        return ok(server.write(fn, args));
    }
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const calls = (name: string) =>
  h.rpc.mock.calls.filter(([fn]) => fn === name).map(([, a]) => a as Record<string, unknown>);

const region = (name: string) => screen.findByRole('region', { name });

async function quoteCapacity60() {
  render(<ClubDiamondCostsPage scopeKind="club" />);
  const prices = await region('Catalog Diamond Prices');
  fireEvent.click(within(prices).getByRole('button', { name: /^Up To 60 Approved Members:/ }));
  fireEvent.click(within(prices).getByRole('button', { name: 'Get A Quote' }));
  return region('Quote Confirm Your Order');
}

describe('the catalog switch', () => {
  it('lists no prices and offers no quote while the catalog is not published', async () => {
    server.visible = false;
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const prices = await region('Catalog Diamond Prices');
    expect(within(prices).getByText('Diamond Prices Are Not Published Yet')).toBeInTheDocument();
    expect(within(prices).queryByRole('button', { name: /Approved Members:/ })).toBeNull();
    expect(within(prices).queryByRole('button', { name: 'Get A Quote' })).toBeNull();
    expect(prices).toHaveAttribute('data-pill', 'Not Published');
  });

  it('prints the capacity rule and points above 2,500 members to a written quote', async () => {
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const prices = await region('Catalog Diamond Prices');
    expect(
      within(prices).getByText(
        /Member Capacity Counts Approved Accounts, Each Once\. It Is Not A Limit On Tables Or\s+Seats Played At Once\./
      )
    ).toBeInTheDocument();
    expect(
      within(prices).getByText('Above 2,500 Members: Ask For A Written Quote')
    ).toBeInTheDocument();
  });

  it.each([
    ['rate_limited', 'Too Many Price Checks. Wait A Few Minutes And Try Again'],
    ['catalog_not_visible', 'Diamond Prices Are Not Published Yet'],
  ])('a %s quote refusal reads in words', async (code, words) => {
    server.quote = () => ({ success: false, error: code, retry_after_seconds: 600 });
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const prices = await region('Catalog Diamond Prices');
    fireEvent.click(within(prices).getByRole('button', { name: /^Up To 60 Approved Members:/ }));
    fireEvent.click(within(prices).getByRole('button', { name: 'Get A Quote' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(words));
    expect(screen.queryByRole('region', { name: 'Quote Confirm Your Order' })).toBeNull();
  });
});

describe('the free month offered beside a purchase', () => {
  it('offers Start Free Month and still lets the owner pay', async () => {
    server.quote = () => quoteFor('capacity_60', 500, { free_month_available: true });
    const quote = await quoteCapacity60();
    expect(within(quote).getByText('Free Month Available')).toBeInTheDocument();
    expect(within(quote).getByRole('button', { name: 'Pay 500 Diamonds' })).toBeEnabled();
    const start = within(quote).getByRole('button', { name: 'Start Free Month: Start' });
    expect(start).toHaveAccessibleDescription(/You Accept Operating Service Terms Version 1\./);
    fireEvent.click(start);
    await waitFor(() =>
      expect(calls('fn_ca_commerce_activate_trial')).toEqual([
        { p_scope_kind: 'club', p_scope_id: CLUB },
      ])
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Quote Confirm Your Order' })).toBeNull()
    );
    expect(calls('fn_ca_commerce_purchase')).toHaveLength(0);
  });

  it('says nothing about a free month when the quote does not', async () => {
    const quote = await quoteCapacity60();
    expect(within(quote).queryByText('Free Month Available')).toBeNull();
  });
});

describe('the operating service terms', () => {
  it('are named on the confirm step and at the free month start', async () => {
    const quote = await quoteCapacity60();
    expect(within(quote).getByText('Operating Service Terms')).toBeInTheDocument();
    expect(within(quote).getByText('Version 1')).toBeInTheDocument();
    expect(
      within(quote).getByText('By Confirming, You Accept Operating Service Terms Version 1.')
    ).toBeInTheDocument();
    const head = screen.getByRole('region', { name: 'Club Operations Diamond Costs' });
    expect(
      within(head).getByRole('button', { name: 'Start Free Month: Start' })
    ).toHaveAccessibleDescription(/You Accept Operating Service Terms Version 1\./);
  });

  it('open their text next to the refund policy', async () => {
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const policies = await region('Policies Refund Policy');
    const toggle = within(policies).getByRole('button', {
      name: 'Operating Service Terms, Version 1: Read',
    });
    expect(within(policies).queryByText(/Software Services For Running A Club/)).toBeNull();
    fireEvent.click(toggle);
    expect(
      within(policies).getByText(
        'Operating Services Are Software Services For Running A Club Or Union.'
      )
    ).toBeInTheDocument();
  });
});

describe('written quotes above 2,500 members', () => {
  it('asks with the capacity and note, every key sent', async () => {
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const wq = await region('Above 2,500 Members Written Quotes');
    const ask = within(wq).getByRole('button', { name: 'Ask For A Quote' });
    fireEvent.change(within(wq).getByLabelText(/^Members Needed \(More Than 2,500\)/), {
      target: { value: '2,500' },
    });
    expect(ask).toBeDisabled();
    fireEvent.change(within(wq).getByLabelText(/^Members Needed \(More Than 2,500\)/), {
      target: { value: '3,000' },
    });
    fireEvent.change(within(wq).getByLabelText(/^Note \(Optional\)/), {
      target: { value: '  Weekend Leagues  ' },
    });
    fireEvent.click(ask);
    await waitFor(() =>
      expect(calls('fn_ca_commerce_written_quote_request')).toEqual([
        {
          p_scope_kind: 'club',
          p_scope_id: CLUB,
          p_requested_capacity: 3000,
          p_note: 'Weekend Leagues',
        },
      ])
    );
    expect(h.toast.success).toHaveBeenCalledWith(
      'Written Quote Requested. Platform Staff Will Reply Here'
    );
  });

  it('shows an open request, withdraws it, and reads each state', async () => {
    server.written = [
      writtenQuote(WQ_OPEN, 'requested', { request_note: 'three towns' }),
      writtenQuote(WQ_OLD, 'declined', {
        requested_capacity: 8000,
        staff_note: 'not available at that size yet',
        decided_at: iso(now - 2 * DAY),
      }),
    ];
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const wq = await region('Above 2,500 Members Written Quotes');
    expect(wq).toHaveAttribute('data-pill', 'Requested');
    expect(within(wq).getByText(/Your Note: Three Towns\./)).toBeInTheDocument();
    expect(
      within(wq).getByText(/Note From Platform Staff: Not Available At That Size Yet\./)
    ).toBeInTheDocument();
    /* One open request per club: no form while it is open. */
    expect(within(wq).queryByRole('button', { name: 'Ask For A Quote' })).toBeNull();
    fireEvent.click(within(wq).getByRole('button', { name: 'Withdraw Request: Withdraw' }));
    await waitFor(() =>
      expect(calls('fn_ca_commerce_written_quote_withdraw')).toEqual([
        { p_written_quote_id: WQ_OPEN },
      ])
    );
  });

  it('buys an offer through the normal order: its private sku, quoted, then confirmed', async () => {
    const sku = 'capacity_wq_0d0d0000000040008000000000000002';
    server.written = [
      writtenQuote(WQ_OFFER, 'offered', {
        offered_capacity: 3000,
        offered_diamonds: 9000,
        sku,
        valid_until: iso(now + 10 * DAY),
        staff_note: 'priced for three towns',
      }),
      writtenQuote(WQ_OLD, 'expired', {
        offered_capacity: 5000,
        offered_diamonds: 14000,
        sku: 'capacity_wq_old',
        valid_until: iso(now - DAY),
      }),
    ];
    server.quote = () => quoteFor(sku, 9000);
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const wq = await region('Above 2,500 Members Written Quotes');
    expect(within(wq).getByText('Up To 3,000 Approved Members')).toBeInTheDocument();
    expect(within(wq).getByText('9,000 Diamonds')).toBeInTheDocument();
    expect(within(wq).getByText('Expired')).toBeInTheDocument();
    expect(within(wq).getAllByRole('button', { name: /^Buy This Written Quote/ })).toHaveLength(1);
    fireEvent.click(within(wq).getByRole('button', { name: 'Buy This Written Quote: Buy' }));
    const quote = await region('Quote Confirm Your Order');
    expect(calls('fn_ca_commerce_quote')).toEqual([
      {
        p_scope_kind: 'club',
        p_scope_id: CLUB,
        p_lines: [{ sku, quantity: 1 }],
        p_sponsorship_id: null,
        p_renewal_max_diamonds: null,
        p_purchase_kind: 'purchase',
      },
    ]);
    expect(
      within(wq).getByRole('button', { name: 'Buy This Written Quote: Quoted' })
    ).toBeInTheDocument();
    fireEvent.click(within(quote).getByRole('button', { name: 'Pay 9,000 Diamonds' }));
    await waitFor(() => expect(calls('fn_ca_commerce_purchase')).toHaveLength(1));
    expect(calls('fn_ca_commerce_purchase')[0].p_quote_id).toBe(`quote-${sku}`);
  });

  it('an expired offer refused at the quote reads in words', async () => {
    server.written = [
      writtenQuote(WQ_OFFER, 'offered', {
        offered_capacity: 3000,
        offered_diamonds: 9000,
        sku: 'capacity_wq_x',
        valid_until: iso(now + 60_000),
      }),
    ];
    server.quote = () => ({ success: false, error: 'written_quote_expired', sku: 'capacity_wq_x' });
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const wq = await region('Above 2,500 Members Written Quotes');
    fireEvent.click(within(wq).getByRole('button', { name: 'Buy This Written Quote: Buy' }));
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        'This Written Quote Has Expired. Ask For A New One'
      )
    );
  });

  it('is not on a union page', async () => {
    h.params = { unionId: UNION };
    server.scopeKind = 'union';
    render(<ClubDiamondCostsPage scopeKind="union" />);
    await region('Catalog Diamond Prices');
    expect(screen.queryByRole('region', { name: 'Above 2,500 Members Written Quotes' })).toBeNull();
    expect(calls('fn_ca_commerce_written_quotes')).toHaveLength(0);
  });
});

describe('the free month review', () => {
  it('is offered once the free month has ended, with a statement of 20 to 2,000 characters', async () => {
    server.trial = { trial_end: iso(now - 3 * DAY), active: false };
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const review = await region('Free Month Free Month Review');
    expect(within(review).getByText('Free Month Ended')).toBeInTheDocument();
    const ask = within(review).getByRole('button', { name: 'Ask For A Review' });
    const box = within(review).getByLabelText(/^Why This Is A New Operation/);
    fireEvent.change(box, { target: { value: 'Too short' } });
    expect(ask).toBeDisabled();
    fireEvent.change(box, {
      target: { value: 'A New Independent Operation In Another City' },
    });
    expect(ask).toBeEnabled();
    fireEvent.click(ask);
    await waitFor(() =>
      expect(calls('fn_ca_commerce_trial_review_request')).toEqual([
        {
          p_scope_kind: 'club',
          p_scope_id: CLUB,
          p_statement: 'A New Independent Operation In Another City',
        },
      ])
    );
  });

  it('is not offered while the free month runs', async () => {
    server.trial = { trial_end: iso(now + 3 * DAY), active: true };
    render(<ClubDiamondCostsPage scopeKind="club" />);
    await region('Catalog Diamond Prices');
    expect(screen.queryByRole('region', { name: 'Free Month Free Month Review' })).toBeNull();
  });

  it('shows each review with its state, staff note and granted end', async () => {
    server.trial = { trial_end: iso(now - 3 * DAY), active: false };
    server.reviews = [
      {
        review_id: 'rv-2',
        scope_kind: 'club',
        scope_id: CLUB,
        operator_id: OWNER,
        requested_by: OWNER,
        statement: 'a separate operation',
        state: 'approved',
        decided_by: 'staff',
        decided_at: iso(now - DAY),
        staff_note: 'separate operation confirmed',
        granted_trial_id: 'trial-2',
        granted_trial_end: iso(now + 29 * DAY),
        created_at: iso(now - 2 * DAY),
      },
      {
        review_id: 'rv-1',
        scope_kind: 'club',
        scope_id: CLUB,
        operator_id: OWNER,
        requested_by: OWNER,
        statement: 'the first request',
        state: 'declined',
        decided_by: 'staff',
        decided_at: iso(now - 5 * DAY),
        staff_note: 'same operation as your first club',
        granted_trial_id: null,
        granted_trial_end: null,
        created_at: iso(now - 6 * DAY),
      },
    ];
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const review = await region('Free Month Free Month Review');
    expect(review).toHaveAttribute('data-pill', 'Approved');
    expect(within(review).getByText('Approved')).toBeInTheDocument();
    expect(within(review).getByText('Declined')).toBeInTheDocument();
    expect(
      within(review).getByText(/Note From Platform Staff: Separate Operation Confirmed\./)
    ).toBeInTheDocument();
    expect(
      within(review).getByText(/Note From Platform Staff: Same Operation As Your First Club\./)
    ).toBeInTheDocument();
    expect(within(review).getByText(/Your Free Month For This Scope Ends /)).toBeInTheDocument();
    /* Granted once: no second request. */
    expect(within(review).queryByRole('button', { name: 'Ask For A Review' })).toBeNull();
  });
});

describe('a union sponsor buys the club insurance module', () => {
  beforeEach(() => {
    h.params = { unionId: UNION };
    server.scopeKind = 'union';
  });

  it('is offered when the platform says it is available, and quoted as a sponsored club order', async () => {
    server.quote = (args) =>
      quoteFor('club_insurance_module', 200, { sponsorship_id: args.p_sponsorship_id });
    render(<ClubDiamondCostsPage scopeKind="union" />);
    const buy = await region('Sponsorship Buy For A Covered Club');
    fireEvent.click(within(buy).getByRole('button', { name: /^Aces High:/ }));
    const ins = within(buy).getByRole('button', { name: /^Club Insurance Software Module:/ });
    expect(ins).toHaveAccessibleDescription(/Insurance Software Access For One Club/);
    fireEvent.click(ins);
    fireEvent.click(within(buy).getByRole('button', { name: 'Get A Quote' }));
    await region('Sponsored Quote Confirm Your Order');
    expect(calls('fn_ca_commerce_quote')).toEqual([
      {
        p_scope_kind: 'club',
        p_scope_id: COVERED,
        p_lines: [{ sku: 'club_insurance_module', quantity: 1 }],
        p_sponsorship_id: SPONSORSHIP,
        p_renewal_max_diamonds: null,
        p_purchase_kind: 'purchase',
      },
    ]);
  });

  it('is not offered while the platform capability is unavailable', async () => {
    server.insuranceAvailable = false;
    render(<ClubDiamondCostsPage scopeKind="union" />);
    const buy = await region('Sponsorship Buy For A Covered Club');
    fireEvent.click(within(buy).getByRole('button', { name: /^Aces High:/ }));
    expect(within(buy).getByRole('button', { name: /^Up To 60 Approved Members:/ })).toBeEnabled();
    expect(
      within(buy).queryByRole('button', { name: /^Club Insurance Software Module:/ })
    ).toBeNull();
  });
});

describe('settled earnings beside operating purchases', () => {
  const coverage = {
    success: true,
    scope_kind: 'club',
    scope_id: CLUB,
    owner_id: OWNER,
    days: 30,
    window_start: iso(now - 30 * DAY),
    window_end: iso(now),
    earnings: {
      source: 'diamond_spins_daily_settlement',
      settled_days: 3,
      credited: 248,
      debited: 50,
      applied_to_debt: 30,
      net_settled: 168,
      unmatched_days: 0,
      pending_unsettled: 25,
      scope: 'owner_all_hosts',
    },
    operating: {
      purchases: 1,
      paid: 500,
      refunded: 200,
      net_paid: 300,
      paid_by_others: 0,
      owner_all_scopes_net_paid: 800,
    },
    comparison_covered: 168,
    lot_provenance: false,
    basis: 'A Comparison',
  };

  it('shows both numbers to the owner, as a comparison', async () => {
    server.earnings = coverage;
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const card = await region('Last 30 Days Settled Earnings');
    expect(
      within(card).getByText('Settled Earnings Can Help Cover Operating Purchases.')
    ).toBeInTheDocument();
    expect(within(card).getByText('168 Diamonds')).toBeInTheDocument();
    expect(within(card).getByText('Operating Purchases For This Club')).toBeInTheDocument();
    expect(within(card).getByText('300 Diamonds')).toBeInTheDocument();
    expect(within(card).getByText(/30 Settled An Earlier Diamond Debt/)).toBeInTheDocument();
    expect(
      within(card).getByText(/25 Diamonds Not Yet Settled Are Not Counted/)
    ).toBeInTheDocument();
    expect(within(card).getByText(/Not A Record Of Which Diamonds Paid/)).toBeInTheDocument();
    expect(calls('fn_ca_commerce_earnings_coverage')).toEqual([
      { p_scope_kind: 'club', p_scope_id: CLUB, p_days: 30 },
    ]);
  });

  it('is not shown when the server refuses the reader', async () => {
    server.role = 'admin';
    render(<ClubDiamondCostsPage scopeKind="club" />);
    await region('Catalog Diamond Prices');
    expect(screen.queryByRole('region', { name: 'Last 30 Days Settled Earnings' })).toBeNull();
  });
});
