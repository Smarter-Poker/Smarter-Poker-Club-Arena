/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useResponsive (8 exported hooks/functions)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  useMediaQuery,
  useIsMobile,
  useIsTablet,
  useIsDesktop,
  useWindowSize,
  useScrollPosition,
  useIsScrolled,
  useToggle,
} from '../../src/hooks/useResponsive';

describe('useResponsive exports', () => {
  it('should export useMediaQuery', () => {
    expect(typeof useMediaQuery).toBe('function');
  });

  it('should export useIsMobile', () => {
    expect(typeof useIsMobile).toBe('function');
  });

  it('should export useIsTablet', () => {
    expect(typeof useIsTablet).toBe('function');
  });

  it('should export useIsDesktop', () => {
    expect(typeof useIsDesktop).toBe('function');
  });

  it('should export useWindowSize', () => {
    expect(typeof useWindowSize).toBe('function');
  });

  it('should export useScrollPosition', () => {
    expect(typeof useScrollPosition).toBe('function');
  });

  it('should export useIsScrolled', () => {
    expect(typeof useIsScrolled).toBe('function');
  });

  it('should export useToggle', () => {
    expect(typeof useToggle).toBe('function');
  });
});
