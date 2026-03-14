/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE SETTINGS SERVICE — Persist User Preferences
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';

export interface TableSettingsData {
  showStackInBB: boolean;
  offlineProtection: boolean;
  autoTimeBank: boolean;
  fourColorDeck: boolean;
  autoMuck: boolean;
  showChat: boolean;
  soundEnabled: boolean;
}

const DEFAULT_SETTINGS: TableSettingsData = {
  showStackInBB: false,
  offlineProtection: false,
  autoTimeBank: false,
  fourColorDeck: false,
  autoMuck: true,
  showChat: true,
  soundEnabled: true,
};

class TableSettingsServiceClass {
  private cache: Map<string, TableSettingsData> = new Map();

  /**
   * Get user's table settings
   */
  async getSettings(userId: string): Promise<TableSettingsData> {
    // Check cache first
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const { data, error } = await retryAsync(
      () => supabase.rpc('fn_get_table_settings', { p_user_id: userId }),
      3
    );

    if (error || !data || data.length === 0) {
      return DEFAULT_SETTINGS;
    }

    const row = data[0];
    const settings: TableSettingsData = {
      showStackInBB: row.show_stack_in_bb,
      offlineProtection: row.offline_protection,
      autoTimeBank: row.auto_time_bank,
      fourColorDeck: row.four_color_deck,
      autoMuck: row.auto_muck,
      showChat: row.show_chat,
      soundEnabled: row.sound_enabled,
    };

    this.cache.set(userId, settings);
    return settings;
  }

  /**
   * Update user's table settings
   */
  async updateSettings(userId: string, updates: Partial<TableSettingsData>): Promise<void> {
    const { error } = await retryAsync(
      () =>
        supabase.rpc('fn_update_table_settings', {
          p_user_id: userId,
          p_show_stack_in_bb: updates.showStackInBB,
          p_offline_protection: updates.offlineProtection,
          p_auto_time_bank: updates.autoTimeBank,
          p_four_color_deck: updates.fourColorDeck,
          p_auto_muck: updates.autoMuck,
          p_show_chat: updates.showChat,
          p_sound_enabled: updates.soundEnabled,
        }),
      3
    );

    if (error) {
      console.error('[TableSettingsService] Failed to save settings:', error);
      throw new Error('Failed to save table settings');
    }

    // Update cache only after successful save
    const current = this.cache.get(userId) || DEFAULT_SETTINGS;
    const newSettings = { ...current, ...updates };
    this.cache.set(userId, newSettings);

    // Notify UI to sync across potentially multiple tables
    masterBus.emit('SETTINGS_UPDATED', { settings: newSettings as Record<string, unknown> });
  }

  /**
   * Clear cache for user
   */
  clearCache(userId: string): void {
    this.cache.delete(userId);
  }
}

export const tableSettingsService = new TableSettingsServiceClass();
