/**
 * E2E Test Utilities
 * Common helpers for Playwright tests
 */

import { Page, expect } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function waitForPageLoad(page: Page) {
    await page.waitForLoadState('networkidle');
}

export async function expectPageToHaveContent(page: Page, text: string | RegExp) {
    await expect(page.locator('body')).toContainText(text);
}

export async function expectNoErrors(page: Page) {
    const errorToast = page.locator('.toast.error');
    await expect(errorToast).not.toBeVisible({ timeout: 1000 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH HELPERS  
// ═══════════════════════════════════════════════════════════════════════════════

export async function loginWithTestUser(page: Page) {
    await page.goto('/auth');
    // This would require test credentials
    // For now, just check page loads
    await expect(page.locator('body')).toBeVisible();
}

export async function logout(page: Page) {
    // Navigate to settings or click logout
    await page.goto('/settings');
    const logoutBtn = page.locator('button:has-text("Logout"), button:has-text("Sign Out")');
    if (await logoutBtn.isVisible()) {
        await logoutBtn.click();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function navigateToClubs(page: Page) {
    await page.goto('/clubs');
    await waitForPageLoad(page);
}

export async function navigateToTournaments(page: Page) {
    await page.goto('/tournaments');
    await waitForPageLoad(page);
}

export async function navigateToWallet(page: Page) {
    await page.goto('/wallet');
    await waitForPageLoad(page);
}

export async function navigateToProfile(page: Page) {
    await page.goto('/profile');
    await waitForPageLoad(page);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function fillInput(page: Page, selector: string, value: string) {
    const input = page.locator(selector);
    await input.clear();
    await input.fill(value);
}

export async function clickButton(page: Page, text: string) {
    const button = page.locator(`button:has-text("${text}")`);
    await button.click();
}

export async function selectOption(page: Page, selector: string, value: string) {
    await page.locator(selector).selectOption(value);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function expectModalOpen(page: Page) {
    const modal = page.locator('.modal, [role="dialog"]');
    await expect(modal).toBeVisible();
}

export async function closeModal(page: Page) {
    const closeBtn = page.locator('.modal .close-btn, [role="dialog"] button:has-text("Close")');
    if (await closeBtn.isVisible()) {
        await closeBtn.click();
    } else {
        await page.keyboard.press('Escape');
    }
}

export async function confirmModal(page: Page) {
    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Yes")');
    await confirmBtn.click();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function expectSuccessToast(page: Page) {
    const toast = page.locator('.toast.success');
    await expect(toast).toBeVisible({ timeout: 5000 });
}

export async function expectErrorToast(page: Page) {
    const toast = page.locator('.toast.error');
    await expect(toast).toBeVisible({ timeout: 5000 });
}

export async function dismissToast(page: Page) {
    const toast = page.locator('.toast');
    if (await toast.isVisible()) {
        await toast.click();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function generateTestEmail(): string {
    const timestamp = Date.now();
    return `test+${timestamp}@clubarena.test`;
}

export function generateTestUsername(): string {
    const timestamp = Date.now();
    return `testuser_${timestamp}`;
}
