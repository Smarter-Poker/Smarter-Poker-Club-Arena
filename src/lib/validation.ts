/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VALIDATION — Form & Data Validation Utilities
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

import { reportError } from '../utils/errorReporter';

export type ValidationResult = {
  valid: boolean;
  error?: string;
};

export type Validator<T> = (value: T) => ValidationResult;

// ═══════════════════════════════════════════════════════════════════════════════
// BASIC VALIDATORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Checks if value is not empty
 */
export function required(message = 'This field is required'): Validator<unknown> {
  return (value) => {
    const isEmpty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    return isEmpty ? { valid: false, error: message } : { valid: true };
  };
}

/**
 * Checks minimum length
 */
export function minLength(min: number, message?: string): Validator<string> {
  return (value) => {
    const msg = message || `Must be at least ${min} characters`;
    return value.length >= min ? { valid: true } : { valid: false, error: msg };
  };
}

/**
 * Checks maximum length
 */
export function maxLength(max: number, message?: string): Validator<string> {
  return (value) => {
    const msg = message || `Must be no more than ${max} characters`;
    return value.length <= max ? { valid: true } : { valid: false, error: msg };
  };
}

/**
 * Checks minimum number value
 */
export function min(minValue: number, message?: string): Validator<number> {
  return (value) => {
    const msg = message || `Must be at least ${minValue}`;
    return value >= minValue ? { valid: true } : { valid: false, error: msg };
  };
}

/**
 * Checks maximum number value
 */
export function max(maxValue: number, message?: string): Validator<number> {
  return (value) => {
    const msg = message || `Must be no more than ${maxValue}`;
    return value <= maxValue ? { valid: true } : { valid: false, error: msg };
  };
}

/**
 * Checks if value matches pattern
 */
export function pattern(regex: RegExp, message = 'Invalid format'): Validator<string> {
  return (value) => {
    return regex.test(value) ? { valid: true } : { valid: false, error: message };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPECIFIC VALIDATORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Email validation
 */
export function email(message = 'Invalid email address'): Validator<string> {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return pattern(emailRegex, message);
}

/**
 * URL validation
 */
export function url(message = 'Invalid URL'): Validator<string> {
  return (value) => {
    try {
      new URL(value);
      return { valid: true };
    } catch (e) {
      reportError(e, 'validation.return');
      return { valid: false, error: message };
    }
  };
}

/**
 * Username validation (alphanumeric + underscore, 3-20 chars)
 */
export function username(message = 'Invalid username'): Validator<string> {
  return (value) => {
    if (value.length < 3) {
      return { valid: false, error: 'Username must be at least 3 characters' };
    }
    if (value.length > 20) {
      return { valid: false, error: 'Username must be no more than 20 characters' };
    }
    if (!/^[a-zA-Z0-9_]+$/.test(value)) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

/**
 * Password strength validation
 */
export function password(options?: {
  minLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireNumbers?: boolean;
  requireSpecial?: boolean;
}): Validator<string> {
  const {
    minLength: minLen = 8,
    requireUppercase = true,
    requireLowercase = true,
    requireNumbers = true,
    requireSpecial = false,
  } = options || {};

  return (value) => {
    if (value.length < minLen) {
      return { valid: false, error: `Password must be at least ${minLen} characters` };
    }
    if (requireUppercase && !/[A-Z]/.test(value)) {
      return { valid: false, error: 'Password must contain an uppercase letter' };
    }
    if (requireLowercase && !/[a-z]/.test(value)) {
      return { valid: false, error: 'Password must contain a lowercase letter' };
    }
    if (requireNumbers && !/[0-9]/.test(value)) {
      return { valid: false, error: 'Password must contain a number' };
    }
    if (requireSpecial && !/[!@#$%^&*(),.?":{}|<>]/.test(value)) {
      return { valid: false, error: 'Password must contain a special character' };
    }
    return { valid: true };
  };
}

/**
 * Matches another field value
 */
export function matches<T>(getOtherValue: () => T, message = 'Values do not match'): Validator<T> {
  return (value) => {
    return value === getOtherValue() ? { valid: true } : { valid: false, error: message };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POKER-SPECIFIC VALIDATORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate bet amount
 */
export function betAmount(options: {
  min: number;
  max: number;
  bigBlind: number;
}): Validator<number> {
  return (value) => {
    if (value < options.min) {
      return { valid: false, error: `Minimum bet is ${options.min}` };
    }
    if (value > options.max) {
      return { valid: false, error: `Maximum bet is ${options.max}` };
    }
    // Bet should be in increments of big blind (optional rule)
    return { valid: true };
  };
}

/**
 * Validate buy-in amount
 */
export function buyInAmount(options: { minBuyIn: number; maxBuyIn: number }): Validator<number> {
  return (value) => {
    if (value < options.minBuyIn) {
      return { valid: false, error: `Minimum buy-in is ${options.minBuyIn}` };
    }
    if (value > options.maxBuyIn) {
      return { valid: false, error: `Maximum buy-in is ${options.maxBuyIn}` };
    }
    return { valid: true };
  };
}

/**
 * Validate table name
 */
export function tableName(): Validator<string> {
  return (value) => {
    const trimmed = value.trim();
    if (trimmed.length < 3) {
      return { valid: false, error: 'Table name must be at least 3 characters' };
    }
    if (trimmed.length > 30) {
      return { valid: false, error: 'Table name must be no more than 30 characters' };
    }
    if (!/^[a-zA-Z0-9\s\-_']+$/.test(trimmed)) {
      return { valid: false, error: 'Table name contains invalid characters' };
    }
    return { valid: true };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITION UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Combine multiple validators
 */
export function compose<T>(...validators: Validator<T>[]): Validator<T> {
  return (value) => {
    for (const validator of validators) {
      const result = validator(value);
      if (!result.valid) {
        return result;
      }
    }
    return { valid: true };
  };
}

/**
 * Validate a form object
 */
export function validateForm<T extends Record<string, unknown>>(
  values: T,
  schema: { [K in keyof T]?: Validator<T[K]> }
): { valid: boolean; errors: Partial<Record<keyof T, string>> } {
  const errors: Partial<Record<keyof T, string>> = {};
  let valid = true;

  for (const key in schema) {
    const validator = schema[key];
    if (validator) {
      const result = validator(values[key]);
      if (!result.valid) {
        valid = false;
        errors[key] = result.error;
      }
    }
  }

  return { valid, errors };
}

/**
 * Create a field validator hook helper
 */
export function createFieldValidator<T>(validator: Validator<T>) {
  return {
    validate: validator,
    isValid: (value: T) => validator(value).valid,
    getError: (value: T) => validator(value).error,
  };
}
