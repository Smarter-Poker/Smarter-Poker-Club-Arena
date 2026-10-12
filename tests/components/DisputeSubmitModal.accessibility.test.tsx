import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DisputeSubmitModal from '../../src/components/wallet/DisputeSubmitModal';

const mocked = vi.hoisted(() => ({
  submit: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'fixture-reader' } }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: mocked.error, success: mocked.success }),
}));
vi.mock('../../src/services/DisputeService', () => ({
  DisputeService: { submitDispute: mocked.submit },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Dispute dialog keyboard and pending-request behavior', () => {
  it('labels every field and lets an idle reader close with Escape', async () => {
    const onClose = vi.fn();
    render(<DisputeSubmitModal isOpen onClose={onClose} clubId="fixture-club" />);
    const type = screen.getByLabelText('Dispute Type');
    expect(screen.getByLabelText('Reference ID (Optional)')).toBeTruthy();
    expect(screen.getByLabelText('Disputed Amount (Chips)')).toBeTruthy();
    expect(screen.getByLabelText('Reason')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(type));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocked.submit).not.toHaveBeenCalled();
  });

  it('keeps one pending dispute open through Escape, backdrop and repeated clicks', async () => {
    let finish!: () => void;
    mocked.submit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const onClose = vi.fn();
    render(<DisputeSubmitModal isOpen onClose={onClose} clubId="fixture-club" />);
    fireEvent.change(screen.getByLabelText('Disputed Amount (Chips)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Review This Fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Dispute' }));
    await waitFor(() => expect(mocked.submit).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(screen.getByRole('button', { name: 'Submitting...' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(mocked.submit).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Disputed Amount (Chips)')).toBeDisabled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
