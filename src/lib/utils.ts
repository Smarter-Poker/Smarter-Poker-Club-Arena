/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🛠️ UTILITY FUNCTIONS — Common Helpers
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// NUMBER FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format a number as currency — EXACT to the penny, zero rounding.
 * All chip/currency values in the platform must show true, real-time
 * precision down to the cent. No abbreviations (K, M) allowed.
 */

import { reportError } from '../utils/errorReporter';

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format chip amounts — EXACT precision, NO rounding, NO abbreviations.
 *
 * CRITICAL DIRECTIVE: Every value must be true and 100% real, defined
 * down to the penny. Zero rounding allowed — not even K/M notation.
 *
 * Examples:
 *   1286.50  → "1,286.50"
 *   50000.00 → "50,000.00"
 *   455123   → "455,123.00"
 *   0.75     → "0.75"
 *   100      → "100.00"
 */
export function formatChips(amount: number): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format chip amount with currency prefix — EXACT precision.
 */
export function formatChipsWithCurrency(amount: number, currency: string = ''): string {
  return `${currency}${formatChips(amount)}`;
}

/**
 * Format chip amount as integer when decimals are .00 — still no abbreviations.
 * Use ONLY for display contexts where the value is guaranteed to be whole chips
 * (e.g., blind levels, stack sizes in whole chips).
 */
export function formatChipsWhole(amount: number): string {
  if (Number.isInteger(amount)) {
    return amount.toLocaleString('en-US');
  }
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a percentage
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATE/TIME FORMATTING — Delegated to lib/date.ts (canonical source)
// These re-exports preserve backward compatibility for any code importing from
// lib/utils while consolidating the implementations in one place.
// ═══════════════════════════════════════════════════════════════════════════════

export { formatRelative as formatRelativeTime, formatDuration, formatTime } from './date';

// ═══════════════════════════════════════════════════════════════════════════════
// STRING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Truncate a string with ellipsis
 */
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return `${str.slice(0, length)}...`;
}

/**
 * Capitalize first letter
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Convert to title case
 */
export function titleCase(str: string): string {
  return str.replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Generate a slug from a string
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// POKER UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format stakes (e.g., "1/2", "5/10") — uses whole-chip display for blinds
 */
export function formatStakes(smallBlind: number, bigBlind: number): string {
  return `${formatChipsWhole(smallBlind)}/${formatChipsWhole(bigBlind)}`;
}

/**
 * Calculate pot odds percentage
 */
export function calculatePotOdds(potSize: number, callAmount: number): number {
  if (callAmount === 0) return 100;
  return (callAmount / (potSize + callAmount)) * 100;
}

// FIX 199: getHandStrengthLabel REMOVED — not allowed for live online gameplay

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Validate username format (alphanumeric, 3-20 chars)
 */
export function isValidUsername(username: string): boolean {
  const regex = /^[a-zA-Z0-9_]{3,20}$/;
  return regex.test(username);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARRAY UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Shuffle an array (Fisher-Yates)
 */
export function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Get unique values from array
 */
export function unique<T>(array: T[]): T[] {
  return [...new Set(array)];
}

/**
 * Group array by key
 */
export function groupBy<T>(array: T[], key: keyof T): Record<string, T[]> {
  return array.reduce(
    (groups, item) => {
      const group = String(item[key]);
      groups[group] = groups[group] || [];
      groups[group].push(item);
      return groups;
    },
    {} as Record<string, T[]>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBOUNCE / THROTTLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Debounce a function
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Throttle a function
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= ms) {
      lastCall = now;
      fn(...args);
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIPBOARD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    reportError(e, 'utils.copyToClipboard');
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RANDOM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a random ID
 */
export function generateId(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a random number in range
 */
export function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
