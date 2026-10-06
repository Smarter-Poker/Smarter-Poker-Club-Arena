import type { Page, Request, Route } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS,
  FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS,
  classifyFinancialReadOnlyRequest,
  installFinancialReadOnlyGuard,
} from '../e2e/helpers/financial-readonly-guard';

type RouteHandler = (route: Route, request: Request) => Promise<unknown> | unknown;

function pageHarness() {
  let installedHandler: RouteHandler | undefined;
  const page = {
    route: vi.fn(async (_pattern: string, handler: RouteHandler) => {
      installedHandler = handler;
    }),
    unroute: vi.fn(async () => undefined),
  } as unknown as Page;

  return {
    page,
    handler: () => {
      if (!installedHandler) throw new Error('Guard route was not installed');
      return installedHandler;
    },
  };
}

function routeHarness(method: string, url: string) {
  const fallback = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const route = {
    request: () => ({ method: () => method, url: () => url }),
    fallback,
    abort,
  } as unknown as Route;
  return { route, fallback, abort };
}

describe('financial read-only request classification', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('allows safe %s requests to any REST resource', (method) => {
    expect(
      classifyFinancialReadOnlyRequest(
        method,
        'https://project.supabase.co/rest/v1/financial_alerts?select=id&token=do-not-report'
      )
    ).toEqual({ action: 'allow', method, path: '/rest/v1/financial_alerts' });
  });

  it('allows only exact reviewed read-only RPC POST paths', () => {
    for (const path of FINANCIAL_ADMIN_READ_ONLY_RPC_PATHS) {
      expect(
        classifyFinancialReadOnlyRequest('post', `https://project.supabase.co${path}?apikey=hidden`)
      ).toEqual({ action: 'allow', method: 'POST', path });
    }

    expect(
      classifyFinancialReadOnlyRequest(
        'POST',
        'https://project.supabase.co/rest/v1/rpc/fn_ca_incident_dashboard_extra'
      )
    ).toMatchObject({ action: 'block' });
    expect(
      classifyFinancialReadOnlyRequest(
        'POST',
        'https://project.supabase.co/rest/v1/financial_alerts'
      )
    ).toMatchObject({ action: 'block' });
  });

  it('keeps the linked-console certificate free of the volatile daily-bonus status RPC', () => {
    expect(FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS).not.toContain(
      '/rest/v1/rpc/fn_ca_daily_bonus_status'
    );

    for (const path of FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS) {
      expect(
        classifyFinancialReadOnlyRequest(
          'POST',
          `https://project.supabase.co${path}`,
          FINANCIAL_ADMIN_CONSOLE_READ_ONLY_RPC_PATHS
        )
      ).toEqual({ action: 'allow', method: 'POST', path });
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks unreviewed REST %s requests', (method) => {
    expect(
      classifyFinancialReadOnlyRequest(
        method,
        'https://project.supabase.co/rest/v1/financial_alerts?id=eq.secret'
      )
    ).toEqual({ action: 'block', method, path: '/rest/v1/financial_alerts' });
  });

  it('ignores auth and non-REST endpoints', () => {
    expect(
      classifyFinancialReadOnlyRequest(
        'POST',
        'https://project.supabase.co/auth/v1/token?grant_type=password&password=hidden'
      )
    ).toEqual({ action: 'ignore', method: 'POST', path: '/auth/v1/token' });
    expect(
      classifyFinancialReadOnlyRequest(
        'POST',
        'https://project.supabase.co/storage/v1/object/avatar'
      )
    ).toEqual({ action: 'ignore', method: 'POST', path: '/storage/v1/object/avatar' });
  });

  it('refuses broad or query-bearing RPC allowlist entries', () => {
    expect(() =>
      classifyFinancialReadOnlyRequest('POST', 'https://project.supabase.co/rest/v1/rpc/safe', [
        '/rest/v1/rpc/*',
      ])
    ).toThrow('exact /rest/v1/rpc/<name> paths');

    let message = '';
    try {
      classifyFinancialReadOnlyRequest('POST', 'https://project.supabase.co/rest/v1/rpc/safe', [
        '/rest/v1/rpc/safe?apikey=never-report-this',
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('exact /rest/v1/rpc/<name> paths');
    expect(message).not.toContain('never-report-this');
  });
});

describe('financial read-only Playwright guard', () => {
  it('records and aborts a mutation with a credential-free method/path assertion', async () => {
    const harness = pageHarness();
    const guard = await installFinancialReadOnlyGuard(harness.page);
    expect(harness.page.route).toHaveBeenCalledWith('**/rest/v1/**', expect.any(Function));

    const blocked = routeHarness(
      'PATCH',
      'https://user:password@project.supabase.co/rest/v1/financial_alerts?id=eq.private&apikey=hidden'
    );
    await harness.handler()(blocked.route, blocked.route.request());

    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.fallback).not.toHaveBeenCalled();
    expect(guard.violations).toEqual([{ method: 'PATCH', path: '/rest/v1/financial_alerts' }]);

    let message = '';
    try {
      guard.assertNoViolations();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('PATCH /rest/v1/financial_alerts');
    expect(message).not.toContain('project.supabase.co');
    expect(message).not.toContain('user');
    expect(message).not.toContain('password');
    expect(message).not.toContain('private');
    expect(message).not.toContain('apikey');
    expect(message).not.toContain('hidden');

    await guard.dispose();
    expect(harness.page.unroute).toHaveBeenCalledWith('**/rest/v1/**', harness.handler());
  });

  it('passes safe methods and reviewed RPC POSTs without recording a violation', async () => {
    const harness = pageHarness();
    const guard = await installFinancialReadOnlyGuard(harness.page);
    const safeRead = routeHarness(
      'GET',
      'https://project.supabase.co/rest/v1/financial_alerts?select=id'
    );
    const reviewedRpc = routeHarness(
      'POST',
      'https://project.supabase.co/rest/v1/rpc/fn_ca_incident_dashboard'
    );

    await harness.handler()(safeRead.route, safeRead.route.request());
    await harness.handler()(reviewedRpc.route, reviewedRpc.route.request());

    expect(safeRead.fallback).toHaveBeenCalledOnce();
    expect(reviewedRpc.fallback).toHaveBeenCalledOnce();
    expect(safeRead.abort).not.toHaveBeenCalled();
    expect(reviewedRpc.abort).not.toHaveBeenCalled();
    expect(guard.violations).toEqual([]);
    expect(() => guard.assertNoViolations()).not.toThrow();
  });
});
