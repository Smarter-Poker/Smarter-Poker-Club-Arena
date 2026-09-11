import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { contrastRatio, isHexColor } from '../utils/colorContrast';
import {
  ManagementContentError,
  type ManagementContentErrorReason,
} from './ManagementContentError';

export type TickerSource =
  | 'overlays'
  | 'starting_soon'
  | 'custom_messages'
  | 'registration_closing'
  | 'guarantees'
  | 'table_openings'
  | 'maintenance'
  | 'winner_results';

export interface ManagedTickerSettings {
  enabled: boolean;
  speedSeconds: number;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: 'Rajdhani' | 'Inter' | 'Roboto Condensed' | 'System';
  sources: Record<TickerSource, boolean>;
  customMessages: string[];
  serviceMessages: string[];
}

export interface ManagedTickerSnapshot {
  settings: ManagedTickerSettings;
  revision: number;
  updatedAt: string | null;
}

export const DEFAULT_TICKER_SETTINGS: ManagedTickerSettings = {
  enabled: true,
  speedSeconds: 24,
  backgroundColor: '#0b1a33',
  textColor: '#f5fbff',
  accentColor: '#00d4ff',
  fontFamily: 'Rajdhani',
  sources: {
    overlays: true,
    starting_soon: true,
    custom_messages: true,
    registration_closing: true,
    guarantees: false,
    table_openings: false,
    maintenance: true,
    winner_results: false,
  },
  customMessages: [],
  serviceMessages: [],
};

const FONTS = new Set<ManagedTickerSettings['fontFamily']>([
  'Rajdhani',
  'Inter',
  'Roboto Condensed',
  'System',
]);

const SOURCE_KEYS = Object.keys(DEFAULT_TICKER_SETTINGS.sources) as TickerSource[];

function cleanMessages(raw: unknown, maximum: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((message): message is string => typeof message === 'string')
    .map((message) => message.replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, maximum);
}

export function normalizeTickerSettings(raw: unknown): ManagedTickerSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_TICKER_SETTINGS,
      sources: { ...DEFAULT_TICKER_SETTINGS.sources },
      customMessages: [],
      serviceMessages: [],
    };
  }
  const row = raw as Record<string, any>;
  const settings = (
    row.settings && typeof row.settings === 'object' ? row.settings : row
  ) as Record<string, any>;
  const rawSpeed = Number(settings.speed_seconds ?? settings.speedSeconds ?? 24);
  const rawSources =
    settings.sources && typeof settings.sources === 'object' && !Array.isArray(settings.sources)
      ? settings.sources
      : {};
  const sources = Object.fromEntries(
    SOURCE_KEYS.map((key) => [
      key,
      typeof rawSources[key] === 'boolean' ? rawSources[key] : DEFAULT_TICKER_SETTINGS.sources[key],
    ])
  ) as Record<TickerSource, boolean>;
  const fontCandidate = settings.font_family ?? settings.fontFamily;
  return {
    ...DEFAULT_TICKER_SETTINGS,
    enabled: typeof settings.enabled === 'boolean' ? settings.enabled : true,
    speedSeconds: Number.isFinite(rawSpeed) ? Math.round(Math.min(60, Math.max(8, rawSpeed))) : 24,
    backgroundColor: isHexColor(settings.background_color ?? settings.backgroundColor)
      ? String(settings.background_color ?? settings.backgroundColor).toLowerCase()
      : DEFAULT_TICKER_SETTINGS.backgroundColor,
    textColor: isHexColor(settings.text_color ?? settings.textColor)
      ? String(settings.text_color ?? settings.textColor).toLowerCase()
      : DEFAULT_TICKER_SETTINGS.textColor,
    accentColor: isHexColor(settings.accent_color ?? settings.accentColor)
      ? String(settings.accent_color ?? settings.accentColor).toLowerCase()
      : DEFAULT_TICKER_SETTINGS.accentColor,
    fontFamily: FONTS.has(fontCandidate) ? fontCandidate : DEFAULT_TICKER_SETTINGS.fontFamily,
    sources,
    customMessages: cleanMessages(settings.custom_messages ?? settings.customMessages, 10),
    serviceMessages: cleanMessages(settings.service_messages ?? settings.serviceMessages, 5),
  };
}

/**
 * The two pairings an operator can actually get wrong.
 *
 * THE FLAG IS NOT ON THIS LIST, AND THAT IS THE POINT. Its text used to be
 * painted with the accent over a background built from the same accent - about
 * 1.06:1, the worst contrast on the platform - and this validator never looked
 * at it. It is not validated now because it cannot be wrong: `readableInk` in
 * tickerTheme.ts derives the chip's ink from the fill's luminance, and the
 * better of the two inks clears 4.5:1 for EVERY six-digit hex (worst case
 * 4.58:1, at luminance 0.179). tests/unit/tickerTheme.test.ts sweeps the colour
 * cube and asserts it. A guarantee by construction beats a check a direct RPC
 * call can walk around.
 */
export function validateTickerContrast(settings: ManagedTickerSettings): string | null {
  if (contrastRatio(settings.textColor, settings.backgroundColor) < 4.5) {
    return 'Ticker text needs at least 4.5:1 contrast against its background.';
  }
  if (contrastRatio(settings.accentColor, settings.backgroundColor) < 3) {
    return 'Ticker accent needs at least 3:1 contrast against its background.';
  }
  return null;
}

const ERROR_MESSAGES: Record<ManagementContentErrorReason, string> = {
  not_authenticated: 'Sign in again before managing the ticker.',
  not_authorized: 'You no longer have permission to manage this ticker.',
  invalid_scope: 'This ticker scope is no longer valid.',
  invalid_payload: 'One or more ticker settings are invalid.',
  invalid_colors: 'Ticker colors must use six-digit hex values.',
  inaccessible_colors: 'Ticker colors do not meet accessible contrast requirements.',
  invalid_font: 'That ticker font is not available.',
  invalid_messages: 'Ticker messages must be non-empty and no longer than 160 characters.',
  character_limit: 'One or more messages exceeds its character limit.',
  message_required: 'A message is required.',
  club_not_found: 'This club no longer exists.',
  announcement_not_found: 'That announcement no longer exists.',
  version_conflict: 'Another operator saved newer ticker settings. Your draft was not overwritten.',
  unavailable: 'Could not load the authoritative ticker settings.',
};

function contentError(
  reason: unknown,
  fallback: string,
  currentRevision: unknown = null
): ManagementContentError {
  const key =
    typeof reason === 'string' && reason in ERROR_MESSAGES
      ? (reason as ManagementContentErrorReason)
      : 'unavailable';
  const revision = Number(currentRevision);
  return new ManagementContentError(
    key,
    ERROR_MESSAGES[key] || fallback,
    Number.isFinite(revision) ? revision : null
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LAST ANSWER THE DATABASE ACTUALLY GAVE (audit 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `get()` used to swallow the error and return DEFAULT_TICKER_SETTINGS, which
 * carries `enabled: true` and its own set of sources. So a club that had
 * deliberately switched the rail OFF got it switched back ON - showing a
 * different mix of announcements than it had chosen - for the duration of any
 * transient failure, and a player saw a bar their club had turned off.
 *
 * Defaults are the right answer for a COLD start and the wrong answer for a
 * failed refresh. The difference is whether we have ever had a real one, so
 * the last authoritative snapshot per scope is kept and handed back instead.
 * Bounded by construction: one entry per club or union a session visits.
 */
const lastKnownGood = new Map<string, ManagedTickerSettings>();
let cacheGeneration = 0;

function scopeKey(clubId?: string | null, unionId?: string | null): string {
  return unionId ? `union:${unionId}` : `club:${clubId || 'none'}`;
}

/** Account transitions must also retire reads that have not returned yet. */
export function resetTickerSettingsCache(): void {
  cacheGeneration += 1;
  lastKnownGood.clear();
}

export const tickerManagementService = {
  async get(clubId?: string | null, unionId?: string | null): Promise<ManagedTickerSettings> {
    const key = scopeKey(clubId, unionId);
    const generation = cacheGeneration;
    const { data, error } = await supabase.rpc('fn_get_game_ticker_settings', {
      p_club_id: clubId || null,
      p_union_id: unionId || null,
    });
    if (generation !== cacheGeneration) return DEFAULT_TICKER_SETTINGS;
    if (error) return lastKnownGood.get(key) ?? DEFAULT_TICKER_SETTINGS;
    const settings = normalizeTickerSettings(data);
    lastKnownGood.set(key, settings);
    return settings;
  },

  async getManagement(scope: 'club' | 'union', scopeId: string): Promise<ManagedTickerSnapshot> {
    const { data, error } = await supabase.rpc('fn_get_game_ticker_settings_for_management', {
      p_scope: scope,
      p_scope_id: scopeId,
    });
    if (error)
      throw contentError('unavailable', error.message || 'Could not load ticker settings.');
    const payload = (data || {}) as Record<string, unknown>;
    if (!payload.ok) throw contentError(payload.reason, 'Could not load ticker settings.');
    const revision = Number(payload.revision);
    if (!Number.isInteger(revision) || revision < 0) {
      throw contentError('invalid_payload', 'Ticker settings returned an invalid revision.');
    }
    return {
      settings: normalizeTickerSettings(payload.settings),
      revision,
      updatedAt: typeof payload.updated_at === 'string' ? payload.updated_at : null,
    };
  },

  async save(
    scope: 'club' | 'union',
    scopeId: string,
    settings: ManagedTickerSettings,
    expectedRevision: number
  ): Promise<ManagedTickerSnapshot> {
    const canonical = normalizeTickerSettings(settings);
    const contrastError = validateTickerContrast(canonical);
    if (contrastError) {
      throw new ManagementContentError('inaccessible_colors', contrastError);
    }
    const { data, error } = await supabase.rpc('fn_save_game_ticker_settings_versioned', {
      p_scope: scope,
      p_scope_id: scopeId,
      p_expected_revision: expectedRevision,
      p_settings: {
        enabled: canonical.enabled,
        speed_seconds: canonical.speedSeconds,
        background_color: canonical.backgroundColor,
        text_color: canonical.textColor,
        accent_color: canonical.accentColor,
        font_family: canonical.fontFamily,
        sources: canonical.sources,
        custom_messages: canonical.customMessages,
        service_messages: canonical.serviceMessages,
      },
    });
    if (error)
      throw contentError('unavailable', error.message || 'Could not save ticker settings.');
    const payload = (data || {}) as Record<string, unknown>;
    if (!payload.ok) {
      throw contentError(
        payload.reason,
        'Could not save ticker settings.',
        payload.current_revision
      );
    }
    const revision = Number(payload.revision);
    if (!Number.isInteger(revision) || revision <= expectedRevision) {
      throw contentError('invalid_payload', 'Ticker save returned an invalid revision.');
    }
    masterBus.emit('TICKER_SETTINGS_CHANGED', { scope, scopeId });
    return {
      settings: normalizeTickerSettings(payload.settings),
      revision,
      updatedAt: typeof payload.updated_at === 'string' ? payload.updated_at : null,
    };
  },
};
