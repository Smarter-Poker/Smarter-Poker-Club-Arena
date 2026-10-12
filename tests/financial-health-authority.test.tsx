import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    pill,
    children,
  }: {
    title: string;
    pill: string;
    children: React.ReactNode;
  }) => (
    <section aria-label={title}>
      <span>{pill}</span>
      {children}
    </section>
  ),
}));

import FinancialHealthPage from '../src/pages/FinancialHealthPage';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Financial Health authority and truth boundary', () => {
  it('renders server-owned truth without a browser mutation or false-green status', () => {
    render(
      <MemoryRouter>
        <FinancialHealthPage />
      </MemoryRouter>
    );

    expect(screen.getByText('Server Managed')).toBeInTheDocument();
    expect(screen.getByText('Not A Health Certificate')).toBeInTheDocument();
    expect(screen.getByText('Unavailable On This Page')).toBeInTheDocument();
    expect(screen.getByText('Global Browser Scan').parentElement).toHaveTextContent('Unavailable');
    expect(screen.queryByRole('button', { name: /run now/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/ledger balanced/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^running$/i)).not.toBeInTheDocument();
  });

  it('keeps the route and every discovery link behind the platform-staff decision', () => {
    const app = source('src/App.tsx');
    const routeAt = app.indexOf('path="financial-health"');
    const route = app.slice(routeAt, app.indexOf('/>', app.indexOf('element={', routeAt)));
    expect(routeAt).toBeGreaterThan(-1);
    expect(route).toContain('<PlatformStaffGuard>');

    const hub = source('src/pages/FinancialAdminHub.tsx');
    const itemAt = hub.indexOf("label: 'System Health'");
    const item = hub.slice(itemAt, hub.indexOf('},', itemAt) + 2);
    expect(item).toContain("path: '/financial-health'");
    expect(item).toContain('staffOnly: true');

    expect(source('src/pages/club/ClubDashboard.tsx')).not.toContain('/financial-health');
    expect(source('src/components/dashboard/ClubFinancialDashboard.tsx')).not.toContain(
      '/financial-health'
    );
    expect(source('src/pages/FinancialHealthPage.tsx')).not.toContain('/financial-alerts');
  });

  it('does not call the retired reconciliation no-op or unscoped suspension scan', () => {
    const page = source('src/pages/FinancialHealthPage.tsx');
    expect(page).not.toContain('FinancialCronService');
    expect(page).not.toContain('runReconciliation');
    expect(page).not.toContain('runSuspensionCheck');
    expect(page).not.toContain('getStatus()');
  });
});
