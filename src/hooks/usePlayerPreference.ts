import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useUserStore } from '../stores/useUserStore';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import {
  awaitPreferenceSave,
  beginTableSettingIntent,
  confirmTableSettingIntent,
  orderTableSettingWrite,
  readTableSettingIntent,
} from '../lib/tableSettingIntents';

const PREFIX = 'ca_player_preference:';

function validShape(value: unknown, fallback: unknown): boolean {
  if (fallback === null) return value === null || typeof value === 'string';
  if (typeof value !== typeof fallback) return false;
  if (typeof value === 'string') return value.length <= 512;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (fallback && typeof fallback === 'object') {
    return Boolean(
      value &&
      !Array.isArray(value) &&
      Object.entries(fallback).every(([key, entry]) =>
        validShape((value as Record<string, unknown>)[key], entry)
      )
    );
  }
  return true;
}

function read<T>(owner: string, name: string, fallback: T): T {
  const pending = readTableSettingIntent(owner, `page:${name}`);
  if (pending && validShape(pending.value, fallback)) return pending.value as T;
  try {
    const raw = localStorage.getItem(`${PREFIX}${owner}:${name}`);
    if (raw !== null) {
      const value: unknown = JSON.parse(raw);
      if (validShape(value, fallback)) return value as T;
    }
  } catch {
    /* Unreadable storage never changes the active selection. */
  }
  return fallback;
}

function cache(owner: string, name: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}${owner}:${name}`, JSON.stringify(value));
  } catch {
    /* Keep the live selection and attempt the account write. */
  }
}

async function save(owner: string, name: string, value: unknown, id: string): Promise<void> {
  if (owner === 'guest') return;
  await orderTableSettingWrite(owner, `page:${name}`, async () => {
    try {
      const { error } = await awaitPreferenceSave(
        supabase.from('user_page_preferences').upsert(
          {
            user_id: owner,
            preference_key: name,
            value,
          },
          { onConflict: 'user_id,preference_key' }
        )
      );
      if (error) throw error;
      confirmTableSettingIntent(owner, `page:${name}`, id);
    } catch (error) {
      reportError(error, 'usePlayerPreference.Save_failed');
    }
  });
}

/** Player-selected filters have no TTL. Mounting never writes a default. */
export function usePlayerPreference<T>(
  name: string,
  initial: T | (() => T),
  scopeId?: string | null
): [T, (next: SetStateAction<T>) => void] {
  const userId = useUserStore((state) => state.user?.id ?? null);
  const owner = userId ?? 'guest';
  // The public URL is shared by full pages and native routing. Embedded lobbies
  // may pass their explicit club instead of inheriting the host page's URL.
  const url = typeof window === 'undefined' ? null : new URL(window.location.href);
  const routeScope = url?.pathname.match(/\/(?:clubs|unions)\/([^/]+)/)?.[1];
  const scopedName = `${name}:${scopeId ?? routeScope ?? url?.searchParams.get('club') ?? 'global'}`;
  const scope = `${owner}:${scopedName}`;
  const fallbackRef = useRef<T>(typeof initial === 'function' ? (initial as () => T)() : initial);
  const [state, setState] = useState(() => ({
    scope,
    value: read(owner, scopedName, fallbackRef.current),
  }));
  const current =
    state.scope === scope ? state.value : read(owner, scopedName, fallbackRef.current);
  const valueRef = useRef({ scope, value: current });
  valueRef.current = { scope, value: current };
  const revisionRef = useRef(0);
  const pendingRef = useRef<{ owner: string; name: string; value: T; id: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) void save(pending.owner, pending.name, pending.value, pending.id);
  }, []);

  useEffect(() => {
    let active = true;
    const revision = revisionRef.current;
    const pending = readTableSettingIntent(owner, `page:${scopedName}`);
    if (pending) {
      void save(owner, scopedName, pending.value, pending.id);
    } else if (userId) {
      void (async () => {
        try {
          const { data, error } = await supabase
            .from('user_page_preferences')
            .select('value')
            .eq('user_id', userId)
            .eq('preference_key', scopedName)
            .maybeSingle();
          if (error) throw error;
          if (
            !active ||
            revisionRef.current !== revision ||
            !data ||
            readTableSettingIntent(owner, `page:${scopedName}`) ||
            !validShape(data.value, fallbackRef.current)
          )
            return;
          cache(owner, scopedName, data.value);
          setState({ scope, value: data.value as T });
        } catch (error) {
          reportError(error, 'usePlayerPreference.Load_failed');
        }
      })();
    }
    return () => {
      active = false;
      flush();
    };
  }, [owner, scopedName, scope, userId, flush]);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [flush]);

  const select = useCallback(
    (next: SetStateAction<T>) => {
      const previous =
        valueRef.current.scope === scope
          ? valueRef.current.value
          : read(owner, scopedName, fallbackRef.current);
      const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
      if (Object.is(previous, value)) return;
      revisionRef.current += 1;
      valueRef.current = { scope, value };
      cache(owner, scopedName, value);
      const id = beginTableSettingIntent(owner, `page:${scopedName}`, value);
      setState({ scope, value });
      pendingRef.current = { owner, name: scopedName, value, id };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, 500);
    },
    [owner, scopedName, scope, flush]
  );
  return [current, select];
}
