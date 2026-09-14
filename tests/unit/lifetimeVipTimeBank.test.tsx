import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/hooks/useButtonImage', () => ({
  useButtonImage: () => '/time-bank.webp',
}));

import { TimebankCounter } from '../../src/components/table/TimebankCounter';
import { visibleTimeBankAllowance } from '../../src/utils/timeBankAllowanceView';

function AllowanceProbe({ owner, active }: { owner: string; active: string }) {
  const visible = visibleTimeBankAllowance(owner, active, 481, true);
  return (
    <output aria-label="Visible Time Bank Allowance">
      {visible.remaining === null ? 'Hidden' : String(visible.remaining)} /
      {visible.unlimited ? ' Unlimited' : ' Finite'}
    </output>
  );
}

describe('Lifetime VIP Time Bank Display', () => {
  it('masks the previous account in the replacement render before effects run', () => {
    const { rerender } = render(<AllowanceProbe owner="account-a" active="account-a" />);
    expect(screen.getByRole('status', { name: 'Visible Time Bank Allowance' }).textContent).toBe(
      '481 / Unlimited'
    );

    rerender(<AllowanceProbe owner="account-a" active="account-b" />);
    expect(screen.getByRole('status', { name: 'Visible Time Bank Allowance' }).textContent).toBe(
      'Hidden / Finite'
    );
  });

  it('renders Unlimited VIP as status and exposes no purchase action', () => {
    const onClick = vi.fn();
    const { container } = render(
      <TimebankCounter count={0} unlimited={true} low={true} onClick={onClick} />
    );

    expect(screen.getByRole('status', { name: 'Unlimited Lifetime VIP Time Banks' })).toBeTruthy();
    expect(container.textContent).toContain('VIP');
    expect(screen.queryByRole('button')).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the ordinary counter actionable', () => {
    const onClick = vi.fn();
    render(<TimebankCounter count={3} onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Time Banks Remaining: 3, 20 Seconds Each' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Table Page Lifetime Wiring', () => {
  const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

  it('uses v2 with a guarded v1 rollout fallback', () => {
    expect(page).toContain("supabase.rpc('fn_time_bank_allowance_v2'");
    expect(page).toContain("supabase.rpc('fn_time_bank_allowance'");
    expect(page).toContain('unlimited_activations');
  });

  it('never opens or advertises the buy-more path for Lifetime', () => {
    expect(page).toContain('open={showTimeBankStore && !timeBankUnlimited}');
    expect(page).toContain('unlimited={timeBankUnlimited}');
    expect(page).toContain('onClick={timeBankUnlimited ? undefined :');
    expect(page).toContain('result.included === true && result.unlimited === true');
    expect(page).toContain('Unlimited Lifetime VIP Time Banks Are Active');
  });

  it('isolates a pending Time Bank purchase from an account replacement', () => {
    expect(page).toContain('const timeBankPurchaseRequestRef = useRef(0)');
    expect(page).toContain('const timeBankPurchaseKeyRef = useRef<{');
    expect(page).toContain('const activeTimeBankBuyerRef = useRef(userId)');
    expect(page).toContain('activeTimeBankBuyerRef.current !== userId');
    expect(page).toContain('timeBankPurchaseKeyRef.current = null');
    expect(page).toContain('const requestedUserId = userId');
    expect(page).toContain("supabase.rpc('fn_purchase_time_banks_v2'");
    expect(page).toContain('p_request_id: purchaseKey');
    expect(page).toContain('const isCurrentRequest = () =>');
    expect(page).toContain('if (!isCurrentRequest()) return false');
    expect(page).toContain('result.idempotent === true && result.granted === false');
    expect(page).toContain('Time Bank Purchase Already Processed');
    expect(page).toContain('userId: requestedUserId');
    expect(page).toContain('if (isCurrentRequest()) buyingTimeBankRef.current = false');
  });

  it('reuses one purchase UUID after ambiguity and rotates it after an authoritative response', () => {
    expect(page).toContain('readOrCreateSessionPurchaseRequestId(purchaseScope)');
    expect(page).toContain('clearSessionPurchaseRequestId(purchaseScope)');
    expect(page).toContain('`time-bank:${requestedUserId}:${quantity}`');
    expect(page).toContain('timeBankPurchaseKeyRef.current.quantity !== quantity');
    expect(page).toContain('const purchaseKey = timeBankPurchaseKeyRef.current.key');

    const rpc = page.indexOf("supabase.rpc('fn_purchase_time_banks_v2'");
    const errorGate = page.indexOf('if (error) throw error', rpc);
    const rotate = page.indexOf('timeBankPurchaseKeyRef.current = null', errorGate);
    const result = page.indexOf('const result = (data ?? {})', rotate);
    const catchAt = page.indexOf('} catch (err) {', rotate);
    expect(rpc).toBeGreaterThan(-1);
    expect(errorGate).toBeGreaterThan(rpc);
    expect(rotate).toBeGreaterThan(errorGate);
    expect(result).toBeGreaterThan(rotate);
    expect(catchAt).toBeGreaterThan(rotate);
    expect(page.slice(catchAt, page.indexOf('} finally {', catchAt))).not.toContain(
      'clearSessionPurchaseRequestId(purchaseScope)'
    );
  });

  it('drops only the in-memory owner on account switch and preserves the session retry key', () => {
    const switchStart = page.indexOf('if (activeTimeBankBuyerRef.current !== userId)');
    const switchEnd = page.indexOf('const [timeBankUnlimitedState', switchStart);
    const switchBlock = page.slice(switchStart, switchEnd);
    expect(switchBlock).toContain('timeBankPurchaseKeyRef.current = null');
    expect(switchBlock).not.toContain('clearSessionPurchaseRequestId');
  });

  it('masks both finite and unlimited allowance state during an account replacement', () => {
    expect(page).toContain('const timeBankAllowanceRequestRef = useRef(0)');
    expect(page).toContain('timeBankAllowanceRequestRef.current === requestId');
    expect(page).toContain('setTimeBankUnlimitedForUser(unlimited, requestedUserId)');
    expect(page).toContain('visibleTimeBankAllowance(');
    expect(page).toContain('timeBankEntitlementUserId,');
    expect(page).toContain('timeBanksRemainingState,');
  });
});
