/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  REFUNDS ARE ASKED FOR ONCE, UNDER A POLICY THE PAGE NAMES BY VERSION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 20260924102040 lets the payer of a paid line REQUEST a refund; staff decide
 * and the engine's commerce consumer executes. The Diamond Costs page owns:
 *
 *   - the request key rules the order key already follows: one key per
 *     opening of the request console, the SAME key on a retry after an
 *     unknown outcome, a NEW key for a new opening;
 *   - the request's state afterwards (Requested, Owed with its reason in
 *     words, Declined with the staff note) and the policy amount the server
 *     computed, never one of its own;
 *   - "Refunds Follow Refund Policy Version N" with the real N on the
 *     confirm step and the receipts, and the policy text itself;
 *   - the balance breakdown (available, reserved, pending, owed);
 *   - the truth about operating access while admission is in shadow
 *     (20260924102056): never "No Access" before an announced date passes;
 *   - a former owner reading their receipts instead of an error.
 *
 * The real ClubCommerceService runs against a fake `supabase.rpc` that
 * answers in the migrations' own JSON shapes.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB = '0c1ab000-0000-4000-8000-000000000001';
const OWNER = '0a0e0000-0000-4000-8000-000000000001';
const OTHER = '0a0e0000-0000-4000-8000-000000000002';
const PURCHASE = '0b0b0000-0000-4000-8000-000000000001';
const ENT = '0e0e0000-0000-4000-8000-000000000001';

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
    effective_from: iso(now - DAY),
  },
});

/** fn_ca_commerce_policies: version 2 of the refund policy is current. */
const POLICIES = [
  {
    policy_id: 'pol-r1',
    kind: 'refund',
    version: 1,
    title: 'Refund Policy',
    body: 'The First Text.',
    effective_from: iso(now - 30 * DAY),
    current: false,
  },
  {
    policy_id: 'pol-r2',
    kind: 'refund',
    version: 2,
    title: 'Refund Policy',
    body: 'A Purchase Made In Error With No Rights Used Is Refunded In Full Within 24 Hours Of Purchase.',
    effective_from: iso(now - 2 * DAY),
    current: true,
  },
  {
    policy_id: 'pol-t1',
    kind: 'renewal_terms',
    version: 1,
    title: 'Renewal Terms',
    body: 'A Renewal Buys The Next Period At The Price Published On Its Due Date.',
    effective_from: iso(now - 30 * DAY),
    current: true,
  },
  {
    policy_id: 'pol-c1',
    kind: 'renewal_ceiling',
    version: 1,
    title: 'Renewal Authorization',
    body: 'I Authorize Club Arena To Renew {product} For Up To {ceiling} Diamonds Per Period, Paid From {payer}, Until I Cancel.',
    effective_from: iso(now - 30 * DAY),
    current: true,
  },
];

/** fn_ca_commerce_refund_request_json */
function requestJson(state: string, extra: Record<string, unknown> = {}) {
  return {
    request_id: `req-${state}`,
    purchase_id: PURCHASE,
    line_index: 0,
    scope_kind: 'club',
    scope_id: CLUB,
    payer_id: OWNER,
    requested_by: OWNER,
    reason_code: 'scope_closed',
    details: null,
    policy_version: 2,
    policy_basis: 'pro_rata_unused_days',
    policy_amount: 466,
    policy_detail: { unused_days: 20, period_days: 30.0417, line_net: 700, refundable: 700 },
    state,
    approved_amount: state === 'requested' || state === 'declined' ? null : 466,
    pending_amount: ['requested', 'approved', 'owed'].includes(state) ? 466 : 0,
    decided_at: state === 'requested' ? null : iso(now - DAY),
    decision_note: null,
    owed_reason: null,
    last_error: null,
    attempts: 0,
    refund_id: null,
    executed_at: null,
    created_at: iso(now - 2 * DAY),
    updated_at: iso(now - DAY),
    ...extra,
  };
}

/** fn_ca_commerce_receipts: receipt_json plus refunds, refund_requests and rights. */
function paidReceipt(extra: Record<string, unknown> = {}) {
  return {
    success: true,
    purchase_id: PURCHASE,
    quote_id: 'quote-0',
    is_replay: true,
    original_total_diamonds: 700,
    original_gross_diamonds: 700,
    trial_waiver: 0,
    charged_this_attempt: 0,
    payer_id: OWNER,
    scope_kind: 'club',
    scope_id: CLUB,
    sponsorship_id: null,
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
        entitlement_id: ENT,
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
        renewal: null,
      },
    ],
    ...extra,
  };
}

type Server = {
  status: Record<string, unknown>;
  receipts: () => unknown[];
  refund: (args: Record<string, unknown>) => { data: unknown; error: unknown };
};
let server: Server;

function ownerStatus(extra: Record<string, unknown> = {}) {
  return {
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
    balance_breakdown: {
      available: 5000,
      reserved: 1250,
      pending_refunds: 900,
      pending_requested: 434,
      pending_approved: 0,
      owed_refunds: 466,
      observed_at: iso(now),
    },
    refund_requests: [],
    ...extra,
  };
}

beforeEach(() => {
  server = {
    status: ownerStatus(),
    receipts: () => [paidReceipt()],
    refund: () => ({
      data: { success: true, is_replay: false, request: requestJson('requested') },
      error: null,
    }),
  };
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    switch (fn) {
      case 'fn_ca_commerce_scope_status':
        return { data: { ...server.status, server_time: iso(Date.now()) }, error: null };
      case 'fn_ca_commerce_catalog':
        return {
          data: {
            catalog_version: 'catalog:1',
            catalog_visible: true,
            checkout_enabled: true,
            nominal_cents_per_diamond: 1,
            products: [capacity(100, 700)],
          },
          error: null,
        };
      case 'fn_ca_commerce_receipts':
        return { data: server.receipts(), error: null };
      case 'fn_ca_commerce_policies':
        return { data: { success: true, policies: POLICIES }, error: null };
      case 'fn_ca_commerce_refund_request':
        return server.refund(args);
      case 'fn_ca_commerce_quote':
        return {
          data: {
            success: true,
            quote_id: 'quote-1',
            expires_at: iso(Date.now() + 15 * 60_000),
            catalog_version: 'catalog:1',
            payer_id: OWNER,
            sponsorship_id: null,
            purchase_kind: 'purchase',
            lines: [{ ...(paidReceipt().lines[0] as object), entitlement_id: undefined }],
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

const records = () => screen.getByRole('region', { name: 'Records Receipts' });

/** The loaded page's head (the loading console carries the same eyebrow and title). */
async function loadedHead() {
  await screen.findByRole('region', { name: 'Records Receipts' });
  return screen.getByRole('region', { name: 'Club Operations Diamond Costs' });
}
const refundConsole = () => screen.getByRole('region', { name: /^Refund / });

async function openRefund() {
  render(<ClubDiamondCostsPage scopeKind="club" />);
  await screen.findByRole('region', { name: 'Records Receipts' });
  fireEvent.click(await within(records()).findByRole('button', { name: /^Request A Refund:/ }));
  return screen.findByRole('region', { name: 'Refund Request A Refund' });
}

describe('Refund requests from receipts', () => {
  it('sends one request for the chosen line and reason, then shows the policy amount', async () => {
    const box = await openRefund();
    const send = within(box).getByRole('button', { name: 'Send Request' });
    expect(send).toBeDisabled();
    fireEvent.click(within(box).getByRole('button', { name: /^Club Or Union Closed:/ }));
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: '  Club Closed  ' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls('fn_ca_commerce_refund_request')).toHaveLength(1));
    const [call] = calls('fn_ca_commerce_refund_request');
    expect(call).toMatchObject({
      p_purchase_id: PURCHASE,
      p_line_index: 0,
      p_reason: 'scope_closed',
      p_details: 'Club Closed',
    });
    expect(String(call.p_request_key).length).toBeGreaterThanOrEqual(8);
    const after = await screen.findByRole('region', { name: 'Refund Refund Request' });
    expect(after).toHaveAttribute('data-pill', 'Requested');
    expect(within(after).getByText('466 Diamonds')).toBeInTheDocument();
    expect(
      within(after).getByText(/Refund Policy Version 2\. 20 Unused Whole Days Of 30, Pro Rata\./)
    ).toBeInTheDocument();
  });

  it('retries an unknown outcome with the SAME key; a new opening gets a NEW key', async () => {
    let attempt = 0;
    server.refund = () => {
      attempt += 1;
      if (attempt === 1) return { data: null, error: { message: 'Failed to fetch' } };
      return {
        data: { success: true, is_replay: true, request: requestJson('requested') },
        error: null,
      };
    };
    const box = await openRefund();
    fireEvent.click(within(box).getByRole('button', { name: /^Service Unavailable:/ }));
    fireEvent.click(within(box).getByRole('button', { name: 'Send Request' }));
    const retry = await screen.findByRole('button', { name: 'Retry Same Request' });
    /* The reason cannot change while the outcome is unknown. */
    expect(
      within(refundConsole()).getByRole('button', { name: /^Platform Defect:/ })
    ).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(calls('fn_ca_commerce_refund_request')).toHaveLength(2));
    const [first, second] = calls('fn_ca_commerce_refund_request');
    expect(second.p_request_key).toBe(first.p_request_key);
    expect(second.p_reason).toBe(first.p_reason);

    /* Close, open again: a new attempt mints a new key. */
    fireEvent.click(await screen.findByRole('button', { name: /^Done:/ }));
    server.receipts = () => [paidReceipt()];
    fireEvent.click(await within(records()).findByRole('button', { name: /^Request A Refund:/ }));
    const again = await screen.findByRole('region', { name: 'Refund Request A Refund' });
    fireEvent.click(within(again).getByRole('button', { name: /^Platform Defect:/ }));
    fireEvent.click(within(again).getByRole('button', { name: 'Send Request' }));
    await waitFor(() => expect(calls('fn_ca_commerce_refund_request')).toHaveLength(3));
    expect(calls('fn_ca_commerce_refund_request')[2].p_request_key).not.toBe(first.p_request_key);
  });

  it('finds a request recorded before the connection dropped, without sending again', async () => {
    server.refund = () => ({ data: null, error: { message: 'Failed to fetch' } });
    const box = await openRefund();
    server.receipts = () => [paidReceipt({ refund_requests: [requestJson('requested')] })];
    fireEvent.click(within(box).getByRole('button', { name: /^Club Or Union Closed:/ }));
    fireEvent.click(within(box).getByRole('button', { name: 'Send Request' }));
    const after = await screen.findByRole('region', { name: 'Refund Refund Request' });
    expect(within(after).getByText('Found On File')).toBeInTheDocument();
    expect(calls('fn_ca_commerce_refund_request')).toHaveLength(1);
  });

  it('prints a policy refusal in words and keeps the form', async () => {
    server.refund = () => ({
      data: {
        success: false,
        error: 'error_window_passed',
        policy_version: 2,
        purchased_at: iso(now - 10 * DAY),
      },
      error: null,
    });
    const box = await openRefund();
    fireEvent.click(within(box).getByRole('button', { name: /^Purchase Made In Error:/ }));
    fireEvent.click(within(box).getByRole('button', { name: 'Send Request' }));
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^A Purchase Made In Error Can Be Refunded Within 24 Hours Of Purchase\. Purchased /
        )
      )
    );
    expect(within(refundConsole()).getByText('Refused')).toBeInTheDocument();
    expect(within(refundConsole()).getByRole('button', { name: 'Send Request' })).toBeEnabled();
  });

  it('shows each state on the receipt and offers no second request while one is open', async () => {
    server.receipts = () => [
      paidReceipt({
        refund_requests: [
          requestJson('declined', {
            request_id: 'r-1',
            decision_note: 'rights were used after the window',
            created_at: iso(now - 5 * DAY),
          }),
          requestJson('owed', { request_id: 'r-2', owed_reason: 'diamond_balance_limit' }),
        ],
      }),
    ];
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const box = await screen.findByRole('region', { name: 'Records Receipts' });
    await within(box).findByText(/Note From Platform Staff: Rights Were Used After The Window\./);
    expect(
      within(box).getByText(/Not Added Yet: Your Diamond Balance Is At Its Limit\./)
    ).toBeInTheDocument();
    expect(within(box).getByText('Declined')).toBeInTheDocument();
    expect(within(box).getByText('Owed')).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: /^Request A Refund:/ })).toBeNull();
  });

  it('is offered only to the payer, and only on a line with something left to return', async () => {
    server.receipts = () => [
      paidReceipt({ payer_id: OTHER }),
      paidReceipt({
        purchase_id: 'p-returned',
        rights: [{ ...paidReceipt().rights[0], refundable: 0 }],
      }),
    ];
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const box = await screen.findByRole('region', { name: 'Records Receipts' });
    await within(box).findAllByText('Up To 100 Approved Members');
    expect(within(box).queryByRole('button', { name: /^Request A Refund:/ })).toBeNull();
  });
});

describe('The refund policy, by its real version', () => {
  it('names the current version on the receipts, the confirm step and the policy console', async () => {
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const box = await screen.findByRole('region', { name: 'Records Receipts' });
    await waitFor(() =>
      expect(within(box).getAllByText(/Refunds Follow Refund Policy Version 2\./)).toHaveLength(2)
    );
    const policy = screen.getByRole('region', { name: 'Policies Refund Policy' });
    expect(policy).toHaveAttribute('data-pill', 'Version 2');
    expect(
      within(policy).getByText(/Refunded In Full Within 24 Hours Of Purchase\./)
    ).toBeInTheDocument();
    expect(within(policy).getByText('Renewal Terms')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Up To 100 Approved Members:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Get A Quote' }));
    const quote = await screen.findByRole('region', { name: 'Quote Confirm Your Order' });
    expect(within(quote).getByText(/Refunds Follow Refund Policy Version 2\./)).toBeInTheDocument();
  });

  it('shows the sentence an owner accepts before authorizing a renewal, and after', async () => {
    const renewal = {
      mandate_id: 'm-1',
      state: 'authorized',
      sku: 'capacity_100',
      quantity: 1,
      max_diamonds: 900,
      due_at: iso(now + 20 * DAY),
      payer_id: OWNER,
      last_result: null,
      sponsorship_id: null,
      terms_version: 1,
      ceiling_text_version: 1,
      accepted_ceiling_text:
        'I Authorize Club Arena To Renew Up To 100 Approved Members For Up To 900 Diamonds Per Period, Paid From My Diamond Balance, Until I Cancel.',
    };
    const right = (r: unknown) => ({
      id: ENT,
      sku: 'capacity_100',
      kind: 'capacity',
      capacity: 100,
      quantity: 1,
      starts_at: iso(now - 10 * DAY),
      ends_at: iso(now + 20 * DAY),
      source: 'purchase',
      purchase_id: PURCHASE,
      net_paid: 700,
      value_basis: 700,
      revision: 1,
      active: true,
      scheduled: false,
      renewal: r,
    });
    server.status = ownerStatus({ entitlements: [right(null)] });
    const { unmount } = render(<ClubDiamondCostsPage scopeKind="club" />);
    const paid = await screen.findByRole('region', { name: 'Rights Paid Access' });
    expect(
      within(paid).getByText(
        /By Authorizing You Accept: "I Authorize Club Arena To Renew Up To 100 Approved Members For Up To 700 Diamonds Per Period, Paid From My Diamond Balance, Until I Cancel\." Renewal Terms Version 1\./
      )
    ).toBeInTheDocument();
    unmount();

    server.status = ownerStatus({ entitlements: [right(renewal)] });
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const after = await screen.findByRole('region', { name: 'Rights Paid Access' });
    expect(
      within(after).getByText(
        /You Accepted: "I Authorize Club Arena To Renew .* Up To 900 Diamonds/
      )
    ).toBeInTheDocument();
  });
});

describe('Balance breakdown and the truth about operating access', () => {
  it('prints available, reserved, pending and owed as the server reports them', async () => {
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const head = await loadedHead();
    for (const [label, value] of [
      ['Available Diamonds', '5,000'],
      ['Reserved (Diamond Arena)', '1,250'],
      ['Pending Refunds', '900'],
      ['Owed Refunds', '466'],
    ]) {
      const row = within(head).getByText(label).parentElement!;
      expect(within(row).getByText(value)).toBeInTheDocument();
    }
  });

  it('never says No Access while enforcement has no date', async () => {
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const head = await loadedHead();
    expect(head).toHaveAttribute('data-pill', 'Not Started');
    expect(screen.queryByText('No Access')).toBeNull();
    expect(
      within(head).getByText(/Will Be Required From A Date That Will Be Announced\./)
    ).toBeInTheDocument();
    expect(within(head).getAllByText(/Date That Will Be Announced/)).toHaveLength(1);
  });

  it('shows the announced date before it passes, and No Access only after', async () => {
    const future = now + 12 * DAY;
    server.status = ownerStatus({ admission_enforced_from: iso(future) });
    const { unmount } = render(<ClubDiamondCostsPage scopeKind="club" />);
    let head = await loadedHead();
    expect(head).toHaveAttribute('data-pill', 'Not Started');
    expect(within(head).getByText(/^Required From /)).toBeInTheDocument();
    unmount();

    server.status = ownerStatus({ admission_enforced_from: iso(now - DAY) });
    render(<ClubDiamondCostsPage scopeKind="club" />);
    head = await loadedHead();
    expect(head).toHaveAttribute('data-pill', 'No Access');
    expect(within(head).getByText('Required')).toBeInTheDocument();
  });
});

describe('A former owner keeps their receipts', () => {
  it('reads the receipts, read only, when the scope refuses access_denied', async () => {
    server.status = { success: false, error: 'access_denied' };
    render(<ClubDiamondCostsPage scopeKind="club" />);
    const head = await screen.findByRole('region', { name: 'Club Records Diamond Costs' });
    expect(head).toHaveAttribute('data-pill', 'Receipts Only');
    expect(within(head).getByText(/You No Longer Manage This Club\./)).toBeInTheDocument();
    const box = screen.getByRole('region', { name: 'Records Receipts' });
    expect(within(box).getByText('Order 0B0B0000')).toBeInTheDocument();
    /* The payer may still ask for a refund of what they paid. */
    expect(within(box).getByRole('button', { name: /^Request A Refund:/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Get A Quote' })).toBeNull();
    expect(screen.queryByText('You Do Not Have Access To This Page')).toBeNull();
  });

  it('still shows the refusal when they paid for nothing here', async () => {
    server.status = { success: false, error: 'access_denied' };
    server.receipts = () => [];
    render(<ClubDiamondCostsPage scopeKind="club" />);
    expect(await screen.findByText('You Do Not Have Access To This Page')).toBeInTheDocument();
  });
});
