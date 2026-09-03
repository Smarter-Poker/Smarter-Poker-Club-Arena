/**
 * Test stub for @sentry/node.
 *
 * @sentry/node is a SERVER-ONLY dependency (installed in server/node_modules,
 * not the client root). Client-side vitest suites that import server services
 * (e.g. tests/unit/TournamentRecurringService.test.ts pulls in
 * server/src/services/errorReporter.ts) would otherwise fail at Vite
 * import-analysis with "Failed to resolve import @sentry/node".
 *
 * Wired up via resolve.alias in vitest.config.ts. Covers every Sentry API the
 * server errorReporter touches; all no-ops.
 */

export function init(_options?: unknown): void {}
export function captureException(_err?: unknown, _ctx?: unknown): string {
  return 'stub-event-id';
}
export function addBreadcrumb(_breadcrumb?: unknown): void {}
export async function flush(_timeout?: number): Promise<boolean> {
  return true;
}
export function setContext(_name?: string, _data?: unknown): void {}
export function onUncaughtExceptionIntegration(): Record<string, never> {
  return {};
}
export function onUnhandledRejectionIntegration(): Record<string, never> {
  return {};
}
