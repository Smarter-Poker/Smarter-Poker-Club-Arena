import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  emit: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('react-router-dom', () => ({ useParams: () => ({ clubId: 'alpha' }) }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'operator' } }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/components/club/ClubIntegrityHeader', () => ({ default: () => null }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => state.rpc(...args) },
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUIDStrict: async () => 'club-alpha',
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: (...args: unknown[]) => state.emit(...args) },
}));
import ReportReviewPage from '../../src/pages/ReportReviewPage';

describe('Report dialog keyboard ownership', () => {
  it('focuses the real close control, traps Tab and restores the case trigger', async () => {
    state.rpc.mockResolvedValue({
      data: [
        {
          id: 'case',
          reason: 'Conduct',
          status: 'pending',
          created_at: '2026-10-12',
          reporter_id: 'a',
          reported_user_id: 'b',
          details: 'Evidence',
        },
      ],
      error: null,
    });
    render(<ReportReviewPage />);
    const trigger = await screen.findByRole('button', { name: /Conduct.*Inspect Case/ });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: 'Close', exact: true });
    await waitFor(() => expect(document.activeElement).toBe(close));
    const last = screen.getByRole('button', { name: 'Take Action' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('refuses a missing decision receipt and restores the pending case', async () => {
    state.toast.success.mockClear();
    state.toast.error.mockClear();
    state.emit.mockClear();
    state.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data:
          name === 'fn_action_player_report'
            ? null
            : [
                {
                  id: 'case',
                  reason: 'Conduct',
                  status: 'pending',
                  created_at: '2026-10-12',
                  reporter_id: 'a',
                  reported_user_id: 'b',
                  details: 'Evidence',
                },
              ],
        error: null,
      })
    );
    render(<ReportReviewPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Conduct.*Inspect Case/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Report' }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalled());
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(state.emit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
