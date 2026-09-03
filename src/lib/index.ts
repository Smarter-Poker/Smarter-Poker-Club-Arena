/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📚 LIB INDEX — Centralized Library Exports
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Formatting Utilities
export * from './utils';

// Animation Utilities: lib/animations.ts deleted 2026-08-19 — framer-motion
// preset library with zero importers anywhere in the app.

// Constants
export * from './constants';

// Form Validation
export * from './validation';

// Date/Time Utilities
// formatDuration, formatTime, and formatRelativeTime (alias for formatRelative)
// are already re-exported via ./utils to avoid duplicate export errors.
export {
  formatDate,
  formatDateTime,
  formatRelative,
  formatCountdown,
  isToday,
  isYesterday,
  isTomorrow,
  isPast,
  isFuture,
  isSameDay,
  addTime,
  startOfDay,
  endOfDay,
  dateDiff,
  formatTournamentTime,
  getTimeUntil,
} from './date';

// Storage Utilities
export * from './storage';

// API Utilities
export * from './api';

// Export Utilities (PDF, CSV)
export * from './export';
