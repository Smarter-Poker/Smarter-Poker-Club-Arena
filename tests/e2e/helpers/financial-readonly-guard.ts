import type { Page, Route } from '@playwright/test';

const REST_ROUTE_GLOB = '**/rest/v1/**';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RPC_PATH = /^\/rest\/v1\/rpc\/[A-Za-z0-9_]+$/;

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

/** Reviewed read-only RPCs mounted by the Financial Admin hub and its linked consoles. */
export const FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS = Object.freeze([
  ...FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS,
  '/rest/v1/rpc/fn_union_overseer_options',
  '/rest/v1/rpc/ca_club_financials',
  '/rest/v1/rpc/ca_club_chip_ledger',
  '/rest/v1/rpc/fn_accounting_run_observation_v1',
] as const);

export type FinancialReadOnlyAction = 'allow' | 'ignore' | 'block';

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
}>;

export type FinancialReadOnlyGuard = Readonly<{
  readonly violations: readonly FinancialReadOnlyViolation[];
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

function classifyWithReviewedPaths(
  method: string,
  rawUrl: string,
  allowedRpcPaths: ReadonlySet<string>
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
  return { action: 'block', method: normalizedMethod, path };
}

export function classifyFinancialReadOnlyRequest(
  method: string,
  rawUrl: string,
  allowedRpcPaths: readonly string[] = FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS
): FinancialReadOnlyDecision {
  return classifyWithReviewedPaths(method, rawUrl, reviewedRpcPathSet(allowedRpcPaths));
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
  const recorded: FinancialReadOnlyViolation[] = [];

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const decision = classifyWithReviewedPaths(request.method(), request.url(), allowedRpcPaths);

    if (decision.action !== 'block') {
      await route.fallback();
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
    assertNoViolations(): void {
      if (recorded.length > 0) throw new Error(violationMessage(recorded));
    },
    async dispose(): Promise<void> {
      await page.unroute(REST_ROUTE_GLOB, handler);
    },
  });
}
