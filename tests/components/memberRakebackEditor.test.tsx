import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
import MemberRakebackEditor from '../../src/components/club/MemberRakebackEditor';

const terms = {
  success: true,
  club_id: 'club',
  user_id: 'player',
  role: 'player',
  rate: 0.2,
  max_rate: 0.5,
};
const props = {
  clubId: 'club',
  userId: 'player',
  role: 'player' as const,
  onClose: vi.fn(),
  onSaved: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: terms, error: null });
});
afterEach(cleanup);
describe('Individual Rakeback Editor', () => {
  it('displays exact stored percentages without floating point tails', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ...terms, rate: 0.55, max_rate: 0.55 },
      error: null,
    });
    render(<MemberRakebackEditor {...props} />);
    const input = await screen.findByRole('spinbutton');
    expect(input).toHaveValue(55);
    expect(input).toHaveAttribute('max', '55');
  });

  it('loads existing terms and saves a chosen percentage as a fraction without a role write', async () => {
    render(<MemberRakebackEditor {...props} />);
    const input = await screen.findByRole('spinbutton', { name: 'Rakeback Percent' });
    expect(input).toHaveValue(20);
    fireEvent.change(input, { target: { value: '32.5' } });
    mocks.rpc.mockResolvedValueOnce({ data: { ...terms, rate: 0.325 }, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Save Rakeback' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      'fn_member_rakeback_terms',
      expect.objectContaining({
        p_club_id: 'club',
        p_user_id: 'player',
        p_role: 'player',
        p_rate: 0.325,
        p_expected_rate: 0.2,
      })
    );
    expect(mocks.rpc.mock.calls.every(([name]) => name === 'fn_member_rakeback_terms')).toBe(true);
  });
  it('saves explicit zero and prevents a duplicate click during the request', async () => {
    render(<MemberRakebackEditor {...props} />);
    const input = await screen.findByRole('spinbutton');
    fireEvent.change(input, { target: { value: '0' } });
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Rakeback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    finish({ data: { ...terms, rate: 0 }, error: null });
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
  });
  it('blocks invalid rates without sending a write', async () => {
    render(<MemberRakebackEditor {...props} />);
    fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Rakeback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Available Limit');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('keeps a refused save visible and requires authoritative reload before another attempt', async () => {
    render(<MemberRakebackEditor {...props} />);
    await screen.findByRole('spinbutton');
    mocks.rpc.mockResolvedValueOnce({
      data: { success: false, error: 'Rakeback Changed' },
      error: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Rakeback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rakeback Changed');
    expect(screen.getByRole('button', { name: 'Save Rakeback' })).toBeDisabled();
    expect(props.onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload Terms' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Rakeback' })).toBeEnabled()
    );
  });
  it('reports a denied read without offering a save', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { success: false, error: 'Not Permitted' },
      error: null,
    });
    render(<MemberRakebackEditor {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not Permitted');
    expect(screen.queryByRole('button', { name: 'Save Rakeback' })).not.toBeInTheDocument();
  });
});
