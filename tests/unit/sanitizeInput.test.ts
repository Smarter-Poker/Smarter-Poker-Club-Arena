/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — sanitizeInput
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { sanitizeInput, sanitizeObject, hasUnsafeContent } from '../../src/utils/sanitizeInput';

describe('sanitizeInput', () => {
  it('should strip HTML tags', () => {
    expect(sanitizeInput('<script>alert("xss")</script>')).not.toContain('<script>');
  });

  it('should return empty string for empty input', () => {
    expect(sanitizeInput('')).toBe('');
  });

  it('should preserve normal text', () => {
    expect(sanitizeInput('Hello World')).toBe('Hello World');
  });

  it('should strip nested tags', () => {
    expect(sanitizeInput('<div><b>bold</b></div>')).toBe('bold');
  });

  it('should trim whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
  });
});

describe('sanitizeObject', () => {
  it('should sanitize string values in object', () => {
    const result = sanitizeObject({ name: '<b>Test</b>', age: 25 });
    expect(result.name).toBe('Test');
    expect(result.age).toBe(25);
  });

  it('should handle empty objects', () => {
    expect(sanitizeObject({})).toEqual({});
  });
});

describe('hasUnsafeContent', () => {
  it('should detect script tags', () => {
    expect(hasUnsafeContent('<script>alert(1)</script>')).toBe(true);
  });

  it('should return false for safe text', () => {
    expect(hasUnsafeContent('Hello World')).toBe(false);
  });

  it('should detect onclick handlers', () => {
    expect(hasUnsafeContent('onclick="hack()"')).toBe(true);
  });

  it('should detect onerror handlers', () => {
    expect(hasUnsafeContent('onerror="hack()"')).toBe(true);
  });

  it('should detect onload handlers', () => {
    expect(hasUnsafeContent('onload="hack()"')).toBe(true);
  });

  it('should detect javascript: URLs', () => {
    expect(hasUnsafeContent('javascript:alert(1)')).toBe(true);
  });
});

describe('sanitizeInput edge cases', () => {
  it('should strip img tags with onerror', () => {
    const xss = '<img src=x onerror=alert(1)>';
    expect(sanitizeInput(xss)).not.toContain('<img');
    expect(sanitizeInput(xss)).not.toContain('onerror');
  });

  it('should preserve unicode characters', () => {
    expect(sanitizeInput('Héllo Wörld 🃏')).toContain('Héllo');
  });

  it('should handle very long strings', () => {
    const longStr = 'a'.repeat(10000);
    expect(sanitizeInput(longStr)).toBe(longStr);
  });

  it('should strip style tags', () => {
    expect(sanitizeInput('<style>body{display:none}</style>Hello')).toBe('body{display:none}Hello');
  });

  it('should handle multiple nested tags', () => {
    expect(sanitizeInput('<div><span><b><i>deep</i></b></span></div>')).toBe('deep');
  });
});

describe('sanitizeObject edge cases', () => {
  it('should preserve non-string values', () => {
    const result = sanitizeObject({ count: 0, active: false, tags: null as any });
    expect(result.count).toBe(0);
    expect(result.active).toBe(false);
  });

  it('should handle multiple string fields', () => {
    const result = sanitizeObject({
      name: '<b>Bold</b>',
      bio: '<script>xss</script>Safe',
    });
    expect(result.name).toBe('Bold');
    expect(result.bio).not.toContain('<script>');
  });
});
