/**
 * ♠ CLUB ARENA — Supabase Client
 * Database connection for clubs, members, and transactions
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('⚠️ Supabase credentials not found. Running in demo mode.');
}

// Use generic client (any) to bypass missing schema type errors
// TODO: Generate proper types with `supabase gen types typescript`
export const supabase: SupabaseClient = createClient(
    supabaseUrl || 'https://demo.supabase.co',
    supabaseAnonKey || 'demo-key',
    {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
        },
        realtime: {
            params: {
                eventsPerSecond: 10,
            },
        },
    }
);

// Helper to check if we're in demo mode
export const isDemoMode = !supabaseUrl || !supabaseAnonKey;

// Real-time subscription helper
export function subscribeToTable<T>(
    table: string,
    callback: (payload: T) => void,
    filter?: { column: string; value: string }
) {
    const channel = supabase
        .channel(`${table}_changes`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table,
                filter: filter ? `${filter.column}=eq.${filter.value}` : undefined,
            },
            (payload) => callback(payload.new as T)
        )
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
}
