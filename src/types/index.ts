/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TYPES — Index Exports
 * ═══════════════════════════════════════════════════════════════════════════════
 * Central export point for all TypeScript types and interfaces
 *
 * Note: database.types is authoritative. club.types provides extended interfaces.
 */

// Database types (Supabase generated + custom) - Authoritative source
export * from './database.types';

// Club types that don't conflict with database.types
// Import specific types from club.types as needed rather than re-exporting all
