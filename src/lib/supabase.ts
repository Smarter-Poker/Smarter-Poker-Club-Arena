/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Supabase Client Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 * Connects to PokerIQ-Production (kuklfnapbkmacvwxktbh)
 */

import { createClient, RealtimeChannel } from '@supabase/supabase-js';

// Environment validation - follows VITE_ prefix law
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Demo mode flag - enables offline/mock data when Supabase not configured
export const isDemoMode = !supabaseUrl || !supabaseAnonKey || supabaseAnonKey === 'placeholder-key';

if (isDemoMode) {
    console.warn(
        '⚠️ Running in DEMO MODE. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env to connect to production.'
    );
}

// Create the Supabase client with realtime enabled for live traffic
export const supabase = createClient(
    supabaseUrl || 'https://kuklfnapbkmacvwxktbh.supabase.co',
    supabaseAnonKey || 'placeholder-key',
    {
        auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true,
        },
        realtime: {
            params: {
                eventsPerSecond: 10,
            },
        },
    }
);

// Filter options for realtime subscriptions
interface SubscribeFilter {
    column: string;
    value: string;
}

// Subscribe to realtime changes on a database table
export function subscribeToTable<T>(
    tableName: string,
    callback: (data: T) => void,
    filter?: SubscribeFilter
): () => void {
    const channelName = filter
        ? `${tableName}:${filter.column}:${filter.value}`
        : tableName;

    const channel: RealtimeChannel = supabase
        .channel(channelName)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: tableName,
            filter: filter ? `${filter.column}=eq.${filter.value}` : undefined
        }, (payload) => {
            callback(payload.new as T);
        })
        .subscribe();

    // Return unsubscribe function
    return () => {
        supabase.removeChannel(channel);
    };
}

// Export type-safe database interface
export type SupabaseClient = typeof supabase;
