import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import ReferralModal from '../../src/components/social/ReferralModal';
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const props = {
  isOpen: true,
  onClose: vi.fn(),
  referralCode: '123456',
  referralLink: 'https://smarter.poker/invite/test',
  totalReferrals: 7,
};
describe('Referral details', () => {
  it('does not invent a zero total when the read is unavailable', () => {
    render(<ReferralModal {...props} totalReferrals={null} />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });
  it('shows the supplied actual referral count', () => {
    render(<ReferralModal {...props} />);
    expect(screen.getByText('7')).toBeTruthy();
  });
  it('allows Escape to dismiss the dialog', () => {
    const onClose = vi.fn();
    render(<ReferralModal {...props} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('reports clipboard refusal without claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    render(<ReferralModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could Not Be Copied')
    );
    expect(screen.queryByText('Copied!')).toBeNull();
  });
});
