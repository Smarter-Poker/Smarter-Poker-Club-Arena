/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  sanitizeInput — Strip Dangerous Content from User Input
 * ═══════════════════════════════════════════════════════════════════════════════
 * Lightweight sanitization for user-generated text (announcements, messages,
 * club names, etc.) to prevent XSS and injection attacks.
 *
 * NOT a full HTML sanitizer — use for plain-text inputs only.
 *
 * @example
 * const safe = sanitizeInput(userInput);
 * await supabase.from('announcements').insert({ content: safe });
 */

/**
 * Strip HTML tags and dangerous characters from user-facing plain text.
 */
export function sanitizeInput(input: string): string {
  if (!input) return '';
  return (
    input
      // Remove HTML tags
      .replace(/<[^>]*>/g, '')
      // Remove script: and data: URLs
      .replace(/(?:javascript|data|vbscript):/gi, '')
      // Remove event handler attributes
      .replace(/on\w+\s*=/gi, '')
      // Trim whitespace
      .trim()
  );
}

/**
 * Sanitize an object's string values (shallow).
 */
export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
  const sanitized = { ...obj };
  for (const key of Object.keys(sanitized)) {
    if (typeof sanitized[key] === 'string') {
      (sanitized as Record<string, unknown>)[key] = sanitizeInput(sanitized[key] as string);
    }
  }
  return sanitized;
}

/**
 * Check if a string looks potentially dangerous (for logging/alerting).
 */
export function hasUnsafeContent(input: string): boolean {
  if (!input) return false;
  return (
    /<script/i.test(input) ||
    /on\w+\s*=/i.test(input) ||
    /javascript:/i.test(input) ||
    /data:text\/html/i.test(input)
  );
}
