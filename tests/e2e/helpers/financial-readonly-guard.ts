import type { Page, Route } from '@playwright/test';

const REST_ROUTE_GLOB = '**/rest/v1/**';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RPC_PATH = /^\/rest\/v1\/rpc\/[A-Za-z0-9_]+$/;
const EXACT_REST_PATH = /^\/rest\/v1\/(?:rpc\/)?[A-Za-z0-9_]+$/;

/**
 * These functions are POSTs because that is how PostgREST invokes RPCs, but
 * each is a reviewed, read-only Financial Admin query. Keep this list exact:
 * an entry grants the browser permission to issue that POST during a live
 * read-only certification.
 */
export const FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS = Object.freeze([
  '/rest/v1/rpc/ca_financial_admin_revenue_series',
  '/rest/v1/rpc/fn_ca_can_view_drift_console',
  '/rest/v1/rpc/fn_ca_incident_dashboard',
] as const);

/** Global shell reads that are reviewed STABLE/select-only database functions. */
export const FINANCIAL_ADMIN_SHELL_READ_ONLY_RPC_PATHS = Object.freeze([
  '/rest/v1/rpc/get_my_full_profile',
  '/rest/v1/rpc/fn_player_spendable_balance',
  '/rest/v1/rpc/fn_batch_club_member_counts',
  '/rest/v1/rpc/fn_can_i_create_a_union',
  '/rest/v1/rpc/fn_can_i_operate_the_union_network',
] as const);

/**
 * Background shell POSTs are genuine writes, so the certificate must never
 * forward them. They are quarantined separately from Financial-page mutation
 * violations because the application shell starts them on every route.
 */
export const FINANCIAL_ADMIN_QUARANTINED_SHELL_POST_PATHS = Object.freeze([
  '/rest/v1/client_shell_telemetry',
  '/rest/v1/rpc/fn_update_presence',
  '/rest/v1/rpc/fn_report_client_errors',
  // App.tsx starts BusEventLogger on every route; it batches client bus events
  // (BALANCE_UPDATED and friends) into an INSERT on bus_event_log every 10s.
  // A genuine write, so it is aborted rather than forwarded, and a shell one,
  // so it is not a Financial page mutation. First seen on /clubs/:id/disputes,
  // Post-Deploy E2E run 37539487040.
  '/rest/v1/bus_event_log',
] as const);

/** Reviewed read-only RPCs mounted by the Financial Admin hub and its linked consoles. */
export const FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS = Object.freeze([
  ...FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS,
  ...FINANCIAL_ADMIN_SHELL_READ_ONLY_RPC_PATHS,
  '/rest/v1/rpc/fn_union_overseer_options',
  '/rest/v1/rpc/ca_club_financials',
  '/rest/v1/rpc/ca_club_chip_ledger',
  '/rest/v1/rpc/fn_accounting_run_observation_v1',
  // Every /clubs/:clubId/* console (Club Disputes, CSV Exports) mounts behind
  // ClubMemberGuard -> ArenaAccessBoundary, which reads fn_poker_arena_context
  // before the page renders, and the Club Operations rail, which reads
  // ca_club_operations_overview. Both are STABLE with only STABLE callees
  // (pg_proc, 2026-10-07). Blocking the first is what rendered "Could Not
  // Verify Arena Access" instead of Club Disputes in run 37539487040.
  '/rest/v1/rpc/fn_poker_arena_context',
  '/rest/v1/rpc/ca_club_operations_overview',
  // CSV Exports (/clubs/:clubId/financials) mounts DynamicWallet, ChipStatement
  // and the jackpot feed. fn_bbj_pool_for_club and fn_ca_chip_statement_page are
  // STABLE; fn_club_money_panel is STABLE since migration 20261007000616, which
  // corrected a select-only function the catalogue had recorded as VOLATILE.
  '/rest/v1/rpc/fn_club_money_panel',
  '/rest/v1/rpc/fn_bbj_pool_for_club',
  '/rest/v1/rpc/fn_ca_chip_statement_page',
  // Diamond Staff Desk and Financial Health fail closed to the arena lobby
  // (PlatformStaffGuard -> <Navigate to="/">), and the lobby mounts these
  // reads before the certificate can stop the page. All STABLE, no DML
  // (pg_proc, 2026-10-07).
  '/rest/v1/rpc/fn_batch_club_realtime_active_counts',
  '/rest/v1/rpc/fn_batch_club_realtime_member_counts',
  '/rest/v1/rpc/fn_get_club_entry_flags',
  '/rest/v1/rpc/get_club_players_playing',
] as const);

export type FinancialReadOnlyAction = 'allow' | 'ignore' | 'quarantine' | 'block';

export type FinancialReadOnlyDecision = Readonly<{
  action: FinancialReadOnlyAction;
  method: string;
  path: string;
}>;

export type FinancialReadOnlyViolation = Readonly<{
  method: string;
  path: string;
}>;

export type FinancialReadOnlyGuardOptions = Readonly<{
  allowedRpcPaths?: readonly string[];
  quarantinedPostPaths?: readonly string[];
}>;

export type FinancialReadOnlyGuard = Readonly<{
  readonly violations: readonly FinancialReadOnlyViolation[];
  readonly quarantinedShellWrites: readonly FinancialReadOnlyViolation[];
  assertNoViolations(): void;
  dispose(): Promise<void>;
}>;

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

function pathnameOnly(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'https://financial-readonly-guard.invalid').pathname;
  } catch {
    // Never echo an unparsable URL because it could contain credentials.
    return '<invalid-url>';
  }
}

function reviewedRpcPathSet(paths: readonly string[]): ReadonlySet<string> {
  const reviewed = new Set<string>();
  for (const path of paths) {
    if (!RPC_PATH.test(path)) {
      throw new Error(
        'Financial read-only RPC allowlist entries must be exact /rest/v1/rpc/<name> paths'
      );
    }
    reviewed.add(path);
  }
  return reviewed;
}

function reviewedQuarantinedPathSet(paths: readonly string[]): ReadonlySet<string> {
  const reviewed = new Set<string>();
  for (const path of paths) {
    if (!EXACT_REST_PATH.test(path)) {
      throw new Error('Financial shell quarantine entries must be exact /rest/v1 paths');
    }
    reviewed.add(path);
  }
  return reviewed;
}

function classifyWithReviewedPaths(
  method: string,
  rawUrl: string,
  allowedRpcPaths: ReadonlySet<string>,
  quarantinedPostPaths: ReadonlySet<string>
): FinancialReadOnlyDecision {
  const normalizedMethod = normalizeMethod(method);
  const path = pathnameOnly(rawUrl);
  const isRestRequest = path === '/rest/v1' || path.startsWith('/rest/v1/');

  if (!isRestRequest) return { action: 'ignore', method: normalizedMethod, path };
  if (SAFE_METHODS.has(normalizedMethod)) {
    return { action: 'allow', method: normalizedMethod, path };
  }
  if (normalizedMethod === 'POST' && allowedRpcPaths.has(path)) {
    return { action: 'allow', method: normalizedMethod, path };
  }
  if (normalizedMethod === 'POST' && quarantinedPostPaths.has(path)) {
    return { action: 'quarantine', method: normalizedMethod, path };
  }
  return { action: 'block', method: normalizedMethod, path };
}

export function classifyFinancialReadOnlyRequest(
  method: string,
  rawUrl: string,
  allowedRpcPaths: readonly string[] = FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS,
  quarantinedPostPaths: readonly string[] = []
): FinancialReadOnlyDecision {
  return classifyWithReviewedPaths(
    method,
    rawUrl,
    reviewedRpcPathSet(allowedRpcPaths),
    reviewedQuarantinedPathSet(quarantinedPostPaths)
  );
}

function violationMessage(violations: readonly FinancialReadOnlyViolation[]): string {
  const requests = violations.map(({ method, path }) => `${method} ${path}`).join(', ');
  return `Financial read-only guard blocked ${violations.length} REST mutation${
    violations.length === 1 ? '' : 's'
  }: ${requests}`;
}

export async function installFinancialReadOnlyGuard(
  page: Page,
  options: FinancialReadOnlyGuardOptions = {}
): Promise<FinancialReadOnlyGuard> {
  const allowedRpcPaths = reviewedRpcPathSet(
    options.allowedRpcPaths ?? FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS
  );
  const quarantinedPostPaths = reviewedQuarantinedPathSet(options.quarantinedPostPaths ?? []);
  for (const path of quarantinedPostPaths) {
    if (allowedRpcPaths.has(path)) {
      throw new Error('A Financial read-only path cannot be both allowed and quarantined');
    }
  }
  const recorded: FinancialReadOnlyViolation[] = [];
  const quarantined: FinancialReadOnlyViolation[] = [];

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const decision = classifyWithReviewedPaths(
      request.method(),
      request.url(),
      allowedRpcPaths,
      quarantinedPostPaths
    );

    if (decision.action === 'allow' || decision.action === 'ignore') {
      await route.fallback();
      return;
    }

    if (decision.action === 'quarantine') {
      quarantined.push(Object.freeze({ method: decision.method, path: decision.path }));
      await route.abort('blockedbyclient');
      return;
    }

    recorded.push(Object.freeze({ method: decision.method, path: decision.path }));
    await route.abort('blockedbyclient');
  };

  await page.route(REST_ROUTE_GLOB, handler);

  return Object.freeze({
    get violations(): readonly FinancialReadOnlyViolation[] {
      return recorded.map((violation) => ({ ...violation }));
    },
    get quarantinedShellWrites(): readonly FinancialReadOnlyViolation[] {
      return quarantined.map((violation) => ({ ...violation }));
    },
    assertNoViolations(): void {
      if (recorded.length > 0) throw new Error(violationMessage(recorded));
    },
    async dispose(): Promise<void> {
      await page.unroute(REST_ROUTE_GLOB, handler);
    },
  });
}
