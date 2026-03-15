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
});
