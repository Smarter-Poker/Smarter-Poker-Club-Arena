import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gatePanel: vi.fn(),
  balanceAsOf: vi.fn(),
}));

vi.mock('../src/services/DriftIncidentService', () => ({
  DriftIncidentService: {
    getGatePanel: (...args: unknown[]) => mocks.gatePanel(...args),
    getBalanceAsOf: (...args: unknown[]) => mocks.balanceAsOf(...args),
  },
}));

vi.mock('../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    pill,
    family,
    crest,
    children,
  }: {
    title: string;
    pill?: string;
    family?: string;
    crest?: string;
    children: React.ReactNode;
  }) => (
    <section aria-label={title} data-family={family} data-crest={crest}>
      <span data-testid="gate-pill">{pill}</span>
      {children}
    </section>
  ),
}));

import DriftGatePanel from '../src/pages/DriftGatePanel';

const panel = {
  gate: {
    run_at: new Date().toISOString(),
    pass: true,
    window_hours: 24,
    failing: null,
    result: {},
  },
  supply_series: [
    {
      taken_at: '2026-10-05T11:00:00Z',
      unexplained: 1200,
      total: 1200,
      cert_wallets: null,
      leaderboard_liability: null,
    },
    {
      taken_at: '2026-10-05T12:00:00Z',
      unexplained: 1250,
      total: 1250,
      cert_wallets: null,
      leaderboard_liability: null,
    },
  ],
  diamond_series: [
    { taken_at: '2026-10-05T11:00:00Z', unexplained: 0, total: 0 },
    { taken_at: '2026-10-05T12:00:00Z', unexplained: 0, total: 0 },
  ],
  open_counts: null,
  generated_at: '2026-10-05T12:00:00Z',
};

beforeEach(() => {
  mocks.gatePanel.mockReset();
  mocks.balanceAsOf.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Drift Gate painted console', () => {
  it('renders Unavailable, never Green, when a critical incident contradicts a green gate', async () => {
    mocks.gatePanel.mockRejectedValue(new Error('green gate with critical incidents'));

    render(<DriftGatePanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Gate Data Unavailable. No Reopen Decision Can Be Verified.'
    );
    expect(screen.getByTestId('gate-pill')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('gate-pill')).not.toHaveTextContent('Green');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders Unavailable, never Green, when a future-dated green gate is rejected', async () => {
    mocks.gatePanel.mockRejectedValue(new Error('future gate decision'));

    render(<DriftGatePanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Gate Data Unavailable. No Reopen Decision Can Be Verified.'
    );
    expect(screen.getByTestId('gate-pill')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('gate-pill')).not.toHaveTextContent('Green');
  });

  it('uses the approved plate-free spade master and names every reconstruction control', async () => {
    mocks.gatePanel.mockResolvedValue(panel);

    render(<DriftGatePanel />);

    const console = await screen.findByRole('region', { name: 'Burn-In Gate' });
    expect(console).toHaveAttribute('data-family', 'spade');
    expect(console).toHaveAttribute('data-crest', 'spade');
    expect(screen.getByTestId('gate-pill')).toHaveTextContent('Green');
    expect(screen.getByRole('combobox', { name: 'Entity Type' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Entity ID' })).toBeInTheDocument();
    expect(screen.getByLabelText('Balance As Of Time')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconstruct' })).toBeDisabled();
    expect(screen.getByText('Latest 1.2K Chips')).toBeInTheDocument();
  });

  it('keeps the last verified gate but removes Green after a contradictory refresh rejects', async () => {
    vi.useFakeTimers();
    mocks.gatePanel
      .mockResolvedValueOnce(panel)
      .mockRejectedValueOnce(new Error('green gate with critical incidents'));

    render(<DriftGatePanel />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('gate-pill')).toHaveTextContent('Green');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByTestId('gate-pill')).toHaveTextContent('Last Verified');
    expect(screen.getByTestId('gate-pill')).not.toHaveTextContent('Green');
    expect(screen.getByText(/Showing The Last Verified Gate/)).toBeInTheDocument();
  });

  it('removes the last verified gate immediately when the same user loses authority', async () => {
    vi.useFakeTimers();
    mocks.gatePanel
      .mockResolvedValueOnce(panel)
      .mockRejectedValueOnce({ code: '42501', message: 'Access Refused' });

    render(<DriftGatePanel />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('gate-pill')).toHaveTextContent('Green');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.queryByRole('region', { name: 'Burn-In Gate' })).toBeNull();
    expect(screen.queryByText(/Showing The Last Verified Gate/)).not.toBeInTheDocument();
  });

  it('renders a compact verified balance readout without raw IDs, keys, or decimals', async () => {
    mocks.gatePanel.mockResolvedValue(panel);
    mocks.balanceAsOf.mockResolvedValue({
      found: true,
      accountType: 'club',
      asOf: '2026-10-05T12:00:00.000Z',
      balance: 1234.56,
      recordedAt: '2026-10-05T11:59:00.000Z',
      direction: 'Incoming',
    });

    render(<DriftGatePanel />);
    await screen.findByRole('region', { name: 'Burn-In Gate' });

    fireEvent.change(screen.getByRole('textbox', { name: 'Entity ID' }), {
      target: { value: '22222222-2222-4222-8222-222222222222' },
    });
    fireEvent.change(screen.getByLabelText('Balance As Of Time'), {
      target: { value: '2026-10-05T12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconstruct' }));

    const readout = await screen.findByRole('status', { name: '' });
    expect(readout).toHaveTextContent('Verified Balance');
    expect(readout).toHaveTextContent('Account TypeClub');
    expect(readout).toHaveTextContent('Balance1.2K Chips');
    expect(readout).toHaveTextContent('Ledger DirectionIncoming');
    expect(readout).not.toHaveTextContent('1234.56');
    expect(readout).not.toHaveTextContent('22222222-2222-4222-8222-222222222222');
    expect(readout).not.toHaveTextContent('entity_id');
    expect(readout).not.toHaveTextContent('ledger_row');
  });

  it('clears the entire protected panel when a balance reconstruction loses authority', async () => {
    mocks.gatePanel.mockResolvedValue(panel);
    mocks.balanceAsOf.mockRejectedValue({ code: '42501', message: 'Access Refused' });

    render(<DriftGatePanel />);
    await screen.findByRole('region', { name: 'Burn-In Gate' });

    fireEvent.change(screen.getByRole('textbox', { name: 'Entity ID' }), {
      target: { value: '22222222-2222-4222-8222-222222222222' },
    });
    fireEvent.change(screen.getByLabelText('Balance As Of Time'), {
      target: { value: '2026-10-05T12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconstruct' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Burn-In Gate' })).toBeNull());
    expect(screen.queryByText('Balance Readout Unavailable')).not.toBeInTheDocument();
  });

  it('stays absent after the server returns a verified management refusal', async () => {
    mocks.gatePanel.mockResolvedValue(null);

    render(<DriftGatePanel />);

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Burn-In Gate' })).toBeNull());
  });
});

describe('Drift Gate console source contract', () => {
  const component = readFileSync(resolve(process.cwd(), 'src/pages/DriftGatePanel.tsx'), 'utf8');
  const css = readFileSync(resolve(process.cwd(), 'src/pages/DriftIncidentsPage.css'), 'utf8');
  const consoleCss = readFileSync(
    resolve(process.cwd(), 'src/components/console/SpadeConsole.css'),
    'utf8'
  );
  const gateCss = css.slice(css.indexOf('/* ── Burn-In Gate'));

  it('uses a truly plate-free painted foot and no generic nested cards or pills', () => {
    const flatFootCss = consoleCss.match(/\.sc__foot\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const sharkFootCss =
      consoleCss.match(/\.sc--family-shark \.sc__foot,[\s\S]*?\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(component).toContain('<SpadeConsole');
    expect(component.match(/family="spade"/g)).toHaveLength(2);
    expect(component.match(/crest="spade"/g)).toHaveLength(2);
    expect(component).not.toMatch(/crest="(?:club|diamond)"/);
    expect(component).not.toContain('family="shark"');
    expect(component).toContain('foot="foot"');
    expect(flatFootCss).toContain('spade-console-v1/bottom-foot.png');
    expect(flatFootCss).not.toContain('bottom-plates.png');
    expect(sharkFootCss).toContain('shark-console-v2/bottom-plate.png');
    expect(component).not.toContain('dgp-card');
    expect(component).not.toContain('dgp-gate-pill');
    expect(component).not.toContain('JSON.stringify');
    expect(component).not.toContain('<pre');
    expect(component).toContain('BalanceAsOfReadout');
    expect(
      [...gateCss.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim())
    ).toEqual(['0']);
    expect(
      [...gateCss.matchAll(/(?:^|\s)background:\s*([^;]+);/gm)].map((match) => match[1].trim())
    ).toEqual(['transparent', 'transparent']);
  });

  it('keeps the 393px form in one shrinkable column with full-width controls', () => {
    expect(gateCss).toMatch(/\.dgp-asof-controls\s*{[^}]*display:\s*grid/s);
    expect(gateCss).not.toMatch(/\.dgp-asof-controls\s*{[^}]*grid-template-columns/s);
    expect(gateCss).toMatch(/\.dgp-control select,[\s\S]*?width:\s*100%/);
    expect(gateCss).toMatch(/\.dgp-control select,[\s\S]*?min-width:\s*0/);
  });
});
