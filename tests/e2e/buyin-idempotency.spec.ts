import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const TABLE_ID = 'b6383a84-ea74-45ba-bb3e-7d8f25865e14';
const USER_ID = 'eb301bd8-9400-4e79-afdb-924b0df6fcd3';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

test.describe('Buy-in Idempotency', () => {
  test('single buy-in idempotency key row', async ({ page }) => {
    test.setTimeout(120000); // 2 minutes

    // Wait, global setup should have logged us in if SP_EMAIL is provided.
    // We go to the table URL directly.
    await page.goto(`/table/${TABLE_ID}`);

    // Wait for an empty seat and click it
    // In Club Arena, seats often have a button with text "Sit"
    const sitButton = page.locator('button', { hasText: 'Sit' }).first();
    await sitButton.waitFor({ state: 'visible', timeout: 30000 });
    await sitButton.click();

    // Wait for buy-in modal to appear
    const buyInModal = page.locator('text=Buy In');
    await expect(buyInModal.first()).toBeVisible({ timeout: 15000 });

    // Click Confirm Buy In (it might say "Confirm", "Buy In", etc)
    const confirmButton = page
      .locator('button', { hasText: /Confirm|Buy In/i })
      .locator('visible=true')
      .last();
    await confirmButton.click();

    // Verify it disappears or we see chips at the seat
    await expect(buyInModal.first()).not.toBeVisible({ timeout: 15000 });

    // We can interact with the table if a hand is dealt, e.g. "Fold" or "Call"
    // For a spin, it might need more players. We will just check the idempotency key for now,
    // since we can't reliably play a hand alone.

    // Now assert Supabase ledger row count
    if (SUPABASE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

      const { data, error } = await supabase
        .from('table_buyin_idempotency_keys')
        .select('*')
        .eq('user_id', USER_ID)
        .eq('table_id', TABLE_ID);

      expect(error).toBeNull();
      // Should have exactly 1 row from the buyin
      expect(data?.length).toBe(1);

      // Cleanup: cashout so seat is empty for next run
      await supabase.rpc('atomic_table_cashout', {
        p_user_id: USER_ID,
        p_table_id: TABLE_ID,
      });
      // Delete idempotency key for next run
      await supabase
        .from('table_buyin_idempotency_keys')
        .delete()
        .eq('user_id', USER_ID)
        .eq('table_id', TABLE_ID);
    }
  });
});
