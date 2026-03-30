/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAITLIST SERVICE — Table Waitlist Management
 * Handles joining, leaving, and managing table waitlists
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { notificationService } from './NotificationService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WaitlistEntry {
  id: string;
  tableId: string;
  tableName: string;
  userId: string;
  position: number;
  joinedAt: string;
  status: 'waiting' | 'notified' | 'seated' | 'expired' | 'left';
  notifiedAt?: string;
}

export interface WaitlistStats {
  position: number;
  totalWaiting: number;
  estimatedWaitMinutes: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class WaitlistServiceClass {
  /**
   * Join a table's waitlist
   */
  async join(tableId: string, userId: string): Promise<WaitlistEntry | null> {
    // Check if already on waitlist
    const existing = await this.getUserWaitlistEntry(tableId, userId);
    if (existing) {
      return existing;
    }

    // Call RPC to join (handles position assignment)
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('join_waitlist', {
          p_table_id: tableId,
          p_user_id: userId,
        }),
      3
    );

    if (error) {
      reportError(error, 'WaitlistService.Failed_to_join');
      return null;
    }

    // Fetch the created entry
    const { data: entry } = await supabase
      .from('table_waitlists')
      .select('*, poker_tables(name)')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('status', 'waiting')
      .maybeSingle();

    if (!entry) return null;

    masterBus.emit('WAITLIST_POSITION_CHANGED', {
      tableId,
      position: entry.position,
      tableName: entry.poker_tables?.name || 'Table',
    });

    return this.mapEntry(entry);
  }

  /**
   * Leave a table's waitlist
   */
  async leave(tableId: string, userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('table_waitlists')
      .update({ status: 'left' })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('status', 'waiting');

    if (error) {
      reportError(error, 'WaitlistService.Failed_to_leave');
      return false;
    }

    masterBus.emit('WAITLIST_POSITION_CHANGED', {
      tableId,
      position: 0,
      tableName: 'Waitlist',
    });

    return true;
  }

  /**
   * Get user's position on a table's waitlist
   */
  async getPosition(tableId: string, userId: string): Promise<WaitlistStats | null> {
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('get_waitlist_position', {
          p_table_id: tableId,
          p_user_id: userId,
        }),
      3
    );

    if (error || data === null) {
      return null;
    }

    // Get total waiting count
    const { count } = await supabase
      .from('table_waitlists')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .eq('status', 'waiting');

    return {
      position: data,
      totalWaiting: count || 0,
      estimatedWaitMinutes: data * 5, // Rough estimate: 5 min per position
    };
  }

  /**
   * Get user's entry on a waitlist
   */
  async getUserWaitlistEntry(tableId: string, userId: string): Promise<WaitlistEntry | null> {
    const { data, error } = await supabase
      .from('table_waitlists')
      .select('*, poker_tables(name)')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('status', 'waiting')
      .maybeSingle();

    if (error || !data) return null;

    return this.mapEntry(data);
  }

  /**
   * Get all active waitlist entries for a user
   */
  async getUserWaitlists(userId: string): Promise<WaitlistEntry[]> {
    const { data, error } = await supabase
      .from('table_waitlists')
      .select('*, poker_tables(name)')
      .eq('user_id', userId)
      .eq('status', 'waiting')
      .order('joined_at', { ascending: true });

    if (error) {
      reportError(error, 'WaitlistService.Failed_to_get_user_waitlists');
      return [];
    }

    return (data || []).map(this.mapEntry);
  }

  /**
   * Get all waitlist entries for a table
   */
  async getTableWaitlist(tableId: string): Promise<WaitlistEntry[]> {
    const { data, error } = await supabase
      .from('table_waitlists')
      .select('*, profiles(username, display_name)')
      .eq('table_id', tableId)
      .eq('status', 'waiting')
      .order('position', { ascending: true });

    if (error) {
      // table_waitlists may not exist yet — silently return empty
      console.debug('[Waitlist] getTableWaitlist:', error.message);
      return [];
    }

    return (data || []).map(this.mapEntry);
  }

  /**
   * Notify next player when a seat opens
   */
  async notifyNextPlayer(tableId: string): Promise<boolean> {
    // Get next waiting player
    const { data: next } = await supabase
      .from('table_waitlists')
      .select('*, poker_tables(name)')
      .eq('table_id', tableId)
      .eq('status', 'waiting')
      .order('position', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!next) {
      return false;
    }

    // Update status to notified
    await supabase
      .from('table_waitlists')
      .update({
        status: 'notified',
        notified_at: new Date().toISOString(),
      })
      .eq('id', next.id);

    // Send notification
    const tableName = next.poker_tables?.name || 'Table';
    await notificationService.notifyWaitlistReady(next.user_id, tableName, tableId);

    masterBus.emit('WAITLIST_POSITION_CHANGED', {
      tableId,
      position: next.position,
      tableName,
    });

    return true;
  }

  /**
   * Mark player as seated (removes from waitlist)
   */
  async markSeated(tableId: string, userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('table_waitlists')
      .update({ status: 'seated' })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .in('status', ['waiting', 'notified']);

    if (error) {
      reportError(error, 'WaitlistService.Failed_to_mark_seated');
      return false;
    }

    masterBus.emit('WAITLIST_POSITION_CHANGED', {
      tableId,
      position: 0,
      tableName: 'Table',
    });

    return true;
  }

  /**
   * Expire old notifications (e.g., if player didn't respond in time)
   */
  async expireOldNotifications(minutesOld: number = 5): Promise<number> {
    const cutoff = new Date(Date.now() - minutesOld * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('table_waitlists')
      .update({ status: 'expired' })
      .eq('status', 'notified')
      .lt('notified_at', cutoff)
      .select();

    if (error) {
      reportError(error, 'WaitlistService.Failed_to_expire_notifications');
      return 0;
    }

    return data?.length || 0;
  }

  /**
   * Map database record to WaitlistEntry
   */
  private mapEntry(data: Record<string, unknown>): WaitlistEntry {
    const table = data.poker_tables as Record<string, unknown> | undefined;
    return {
      id: data.id as string,
      tableId: data.table_id as string,
      tableName: (table?.name as string) || 'Unknown Table',
      userId: data.user_id as string,
      position: data.position as number,
      joinedAt: data.joined_at as string,
      status: data.status as WaitlistEntry['status'],
      notifiedAt: data.notified_at as string | undefined,
    };
  }
}

// Export singleton instance
export const waitlistService = new WaitlistServiceClass();
