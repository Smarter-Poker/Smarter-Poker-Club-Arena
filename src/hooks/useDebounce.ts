/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useDebounce — Debounced Value Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 * Returns a debounced version of the input value. Useful for search inputs
 * and filter changes to avoid firing Supabase queries on every keystroke.
 *
 * @example
 * const [query, setQuery] = useState('');
 * const debouncedQuery = useDebounce(query, 300);
 * // debouncedQuery only updates 300ms after the user stops typing
 */

import { useState, useEffect } from 'react';

export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}

export default useDebounce;
