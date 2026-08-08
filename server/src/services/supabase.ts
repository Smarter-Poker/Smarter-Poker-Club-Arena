/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SUPABASE CLIENT — Server-Side (Service Role)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Uses SERVICE_ROLE key for full database access — bypasses RLS.
 * ZERO browser dependencies. Runs on Node.js.
 *
 * BARREL. The implementation was split out of this file into
 * `src/services/supabase/*.ts` on 2026-08-08 because every deploy tool in this
 * pipeline caps a single file at ~50 KB and this module had reached 57 KB.
 * The split is a pure move — function bodies are unchanged. This file re-exports
 * the complete public surface under the exact same names, so every existing
 * `from '../services/supabase.js'` import keeps working untouched.
 *
 * New code may import a submodule directly. Submodules must NEVER import from
 * this barrel — they take the shared client from './supabase/client.js', which
 * is what keeps the module graph acyclic.
 */

export * from './supabase/client.js';
export * from './supabase/tables.js';
export * from './supabase/seats.js';
export * from './supabase/wallets.js';
export * from './supabase/rake.js';
export * from './supabase/bbj.js';
export * from './supabase/handHistory.js';
export * from './supabase/snapshots.js';

// `export *` does not forward a default export — re-declare it so the legacy
// `import supabase from '../services/supabase.js'` form still resolves.
import { supabase } from './supabase/client.js';
export default supabase;
