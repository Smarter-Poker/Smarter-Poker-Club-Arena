/**
 * The Diamond Arena statement renders every outcome the read can return, and
 * never a balance it did not read.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DiamondArenaStatement as Statement } from '@/services/DiamondService';

const getArenaStatement = vi.fn<() => Promise<Statement | null>>();
vi.mock('@/services/DiamondService', () => ({
  DiamondService: { getArenaStatement: () => getArenaStatement() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} } }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { default: DiamondArenaStatement } =
  await import('@/components/wallet/DiamondArenaStatement');

const statement = (over: Partial<Statement> = {}): Statement => ({
  sessions: 3,
  openSessions: 1,
  buyIns: 380,
  cashOuts: 410,
  inPlay: 120,
  netResultSettled: 30,
  unmatched: [],
  balanced: true,
  readAt: '2026-09-14T00:00:00Z',
  ...over,
});

describe('DiamondArenaStatement', () => {
  beforeEach(() => getArenaStatement.mockReset());

  it('says it is reading, then shows the figures and that every session reconciles', async () => {
    let resolve!: (s: Statement) => void;
    getArenaStatement.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<DiamondArenaStatement userId="u-1" />);
    expect(screen.getByText('Reading Your Diamond Arena Statement...')).toBeTruthy();
    resolve(statement());
    await waitFor(() =>
      expect(
        screen.getByText(
          'Every Session Reconciles: Each Buy-In And Cash-Out Matches Its Wallet Entry.'
        )
      ).toBeTruthy()
    );
    expect(screen.getByText('3 (1 Open)')).toBeTruthy();
    expect(screen.getByText('380')).toBeTruthy();
    expect(screen.getByText('410')).toBeTruthy();
    expect(screen.getByText('+30')).toBeTruthy();
  });

  it('a failed read is Unavailable with a retry, never zeros', async () => {
    getArenaStatement.mockResolvedValueOnce(null).mockResolvedValueOnce(statement({ sessions: 0 }));
    render(<DiamondArenaStatement userId="u-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText('0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/No Diamond Arena Sessions Yet/)).toBeTruthy());
  });

  it("names each line that does not reconcile, in the player's words", async () => {
    getArenaStatement.mockResolvedValueOnce(
      statement({
        balanced: false,
        netResultSettled: -30,
        unmatched: [
          {
            custodyId: '4d9ba417-154b-482e-800a-b6277da125cb',
            requestId: null,
            reason: 'release_movement_missing',
          },
          {
            custodyId: 'aaaaaaaa-0000-0000-0000-000000000000',
            requestId: 'r-1',
            reason: 'seat_stack_drift',
          },
        ],
      })
    );
    render(<DiamondArenaStatement userId="u-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(
      screen.getByText(
        '2 Lines Do Not Reconcile. Nothing Has Been Taken From You; Operations Corrects The Record At The Source.'
      )
    ).toBeTruthy();
    expect(screen.getByText('A Finished Session Has No Cash-Out On Record')).toBeTruthy();
    expect(screen.getByText('A Seat Stack Differs From The Diamonds Held For It')).toBeTruthy();
    expect(screen.getByText('Session 4d9ba417')).toBeTruthy();
    expect(screen.getByText('-30')).toBeTruthy();
  });

  it('never a chip on the statement', async () => {
    getArenaStatement.mockResolvedValueOnce(statement());
    const { container } = render(<DiamondArenaStatement userId="u-1" />);
    await waitFor(() => expect(screen.getByText('380')).toBeTruthy());
    expect(container.textContent).not.toMatch(/chip/i);
  });
});
