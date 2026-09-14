import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/VIPService', () => ({
  VIP_MONTHLY_ALLOWANCES: {
    rabbitHunts: 100,
    timeBankSeconds: 120,
    emojis: 1200,
    tags: 1000,
    throwables: 500,
  },
  FEATURE_PRICING: {
    rabbit_hunt: { cost: 5, usageType: 'per_use' },
    show_stack_bb: { cost: 5, usageType: 'per_session' },
    offline_protection: { cost: 10, usageType: 'per_session' },
    auto_time_bank: { cost: 5, usageType: 'per_use' },
    time_bank_seconds: { cost: 5, usageType: 'per_use' },
    emoji_pack: { cost: 1, usageType: 'permanent' },
    tag_pack: { cost: 1, usageType: 'permanent' },
    throwable: { cost: 1, usageType: 'per_use' },
  },
  isPurchasable: () => true,
  loadFeaturePricing: vi.fn().mockResolvedValue({}),
}));

import { VIPCardsModal } from '../../src/components/vip/VIPCardsModal';

afterEach(cleanup);

describe('VIP Cards Modal', () => {
  it('shows the complete Lifetime digital entitlement without finite monthly meters', () => {
    render(<VIPCardsModal isOpen={true} onClose={vi.fn()} vipStatus="lifetime" />);

    expect(screen.getByRole('heading', { name: 'Lifetime VIP' })).toBeTruthy();
    expect(screen.getByText('Lifetime Membership Active')).toBeTruthy();
    expect(screen.getAllByText('Unlimited').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('All Digital Packs')).toHaveLength(2);
    expect(screen.getByText('All Cataloged Table Skins And Backgrounds')).toBeTruthy();
    expect(screen.getByText('All Cataloged Card Backs And Dealer Buttons')).toBeTruthy();
    expect(screen.getByText('All VIP Avatars, Frames, And Auras')).toBeTruthy();
    expect(screen.queryByText(/\/ Mo/)).toBeNull();
  });

  it('keeps the non-member upgrade inside the current page', () => {
    const onClose = vi.fn();
    render(<VIPCardsModal isOpen={true} onClose={onClose} vipStatus="none" />);

    const link = screen.getByRole('link', { name: 'Join Club Arena For A Membership' });
    expect(link.getAttribute('href')).toBe('/hub/vip-membership');
    expect(link.getAttribute('target')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close VIP Benefits' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
