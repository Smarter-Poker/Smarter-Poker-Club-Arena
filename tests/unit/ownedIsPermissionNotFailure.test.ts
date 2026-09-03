/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A FEATURE YOU OWN IS PERMISSION, NOT A FAILED PURCHASE (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_purchase_feature answers a feature the player ALREADY OWNS with
 * `{ success: false, error: 'already_owned' }` — a refusal, not a failure.
 * VIPService.purchaseFeature surfaces that as `alreadyOwned: true`, and two
 * call sites ignored it:
 *
 *   EmojiPicker      'emoji_pack' is priced `permanent`, so after the first
 *                    purchase EVERY premium emoji tap showed "Insufficient
 *                    diamonds" and sent nothing.
 *   PlayerNotesPanel 'tag_pack' likewise — a non-VIP could add exactly ONE
 *                    player tag, ever, and was then repeatedly asked to buy
 *                    diamonds for something they owned.
 *
 * Both also lacked an in-flight latch, so a double tap issued two charges.
 * These are source-contract pins: the components need a table, a bus and an
 * auth session to render, so the guard is asserted where it lives.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

describe('VIPService reports ownership distinctly from failure', () => {
  const src = read('services/VIPService.ts');

  it('still returns alreadyOwned so callers can tell the two apart', () => {
    expect(src).toMatch(/alreadyOwned:\s*reason === 'already_owned'/);
  });
});

describe('paid pickers treat ownership as permission', () => {
  const emoji = read('components/table/EmojiPicker.tsx');
  const notes = read('components/gameplay/PlayerNotesPanel.tsx');

  it('EmojiPicker only refuses when the purchase failed AND is not owned', () => {
    expect(emoji).toContain('if (!result.success && !result.alreadyOwned)');
  });

  it('EmojiPicker announces a charge only when one happened', () => {
    expect(emoji).toContain('if (result.charged > 0)');
  });

  it('PlayerNotesPanel only opens the top-up sheet when not owned', () => {
    expect(notes).toContain('if (!result.success && !result.alreadyOwned)');
  });
});

describe('every paid tap has an in-flight latch', () => {
  it('EmojiPicker latches on a ref and disables the premium buttons', () => {
    const src = read('components/table/EmojiPicker.tsx');
    expect(src).toContain('busyRef');
    expect(src).toMatch(/if \(busyRef\.current\) return;/);
    expect(src).toContain('disabled={purchasing}');
  });

  it('PlayerNotesPanel latches the paid tag purchase', () => {
    const src = read('components/gameplay/PlayerNotesPanel.tsx');
    expect(src).toContain('tagPurchaseRef');
    expect(src).toMatch(/if \(tagPurchaseRef\.current\) return;/);
  });

  it('ThrowableSelector latches the send and disables the grid', () => {
    const src = read('components/table/ThrowableSelector.tsx');
    expect(src).toContain('sendingRef');
    expect(src).toMatch(/if \(sendingRef\.current\) return;/);
    expect(src).toContain('disabled={sending}');
  });

  it('Table Studio checks its in-flight latch on the CONFIRM path', () => {
    const src = read('components/table/ThemeSettingsModal.tsx');
    const confirmAt = src.indexOf('const handleAssetPurchase');
    expect(confirmAt).toBeGreaterThan(-1);
    // The busy check must appear inside the handler, before the purchase.
    const body = src.slice(confirmAt, src.indexOf("supabase.rpc('fn_purchase_feature'", confirmAt));
    expect(body).toContain('purchaseBusyRef.current');
  });
});
