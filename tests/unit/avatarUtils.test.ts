/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — avatarUtils
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { resolveAvatarDisplay, getInitials } from '../../src/utils/avatarUtils';

describe('resolveAvatarDisplay', () => {
  it('should return the URL when provided', () => {
    const result = resolveAvatarDisplay('https://example.com/avatar.png');
    expect(result).toBe('https://example.com/avatar.png');
  });

  it('should return a fallback for null URL', () => {
    const result = resolveAvatarDisplay(null, 'user-123');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should return a fallback for undefined URL', () => {
    const result = resolveAvatarDisplay(undefined, 'user-456');
    expect(result).toBeDefined();
  });

  it('should return a fallback for empty string', () => {
    const result = resolveAvatarDisplay('', 'user-789');
    expect(result).toBeDefined();
  });
});

describe('getInitials', () => {
  it('should return initials from a full name', () => {
    expect(getInitials('John Doe')).toBe('JD');
  });

  it('should return single initial for single name', () => {
    const initials = getInitials('John');
    expect(initials.length).toBeLessThanOrEqual(2);
    expect(initials).toContain('J');
  });

  it('should return fallback for null', () => {
    const result = getInitials(null);
    expect(typeof result).toBe('string');
  });

  it('should return fallback for undefined', () => {
    const result = getInitials(undefined);
    expect(typeof result).toBe('string');
  });

  it('should return fallback for empty string', () => {
    const result = getInitials('');
    expect(typeof result).toBe('string');
  });
});
