/**
 * LIGHTNING PHASE 8: WARM RESUME, THE NON-ECONOMIC KIND.
 *
 * What a returning Lightning player would otherwise set again: the last
 * Cluster (and its stakes) they played, how many Lightning tables they had
 * open, whether the Session panel was showing, and whether they prefer FOLD
 * & WATCH. Per device, in localStorage, every read and write guarded: a
 * private window or blocked storage simply starts from the defaults.
 *
 * NOTHING HERE SPENDS. These are reminders of where the player was. A
 * remembered Cluster is offered as a door; the buy-in confirmation of the
 * existing join flow is the only way in, every time.
 */
export const LIGHTNING_PREFS_STORAGE_KEY = 'ca.lightning.prefs.v1';

export interface LightningPrefs {
  lastClusterId: string | null;
  lastClusterName: string | null;
  lastStakes: string | null;
  /** Lightning tables open at the end of the last visit (1..4). */
  tableCount: number;
  statsVisible: boolean;
  preferFoldWatch: boolean;
}

export const LIGHTNING_PREFS_DEFAULTS: Readonly<LightningPrefs> = Object.freeze({
  lastClusterId: null,
  lastClusterName: null,
  lastStakes: null,
  tableCount: 1,
  statsVisible: false,
  preferFoldWatch: false,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(raw: unknown): LightningPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const count = Number(r.tableCount);
  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null;
  return {
    lastClusterId:
      typeof r.lastClusterId === 'string' && UUID_RE.test(r.lastClusterId) ? r.lastClusterId : null,
    lastClusterName: str(r.lastClusterName, 80),
    lastStakes: str(r.lastStakes, 24),
    tableCount: Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1,
    statsVisible: r.statsVisible === true,
    preferFoldWatch: r.preferFoldWatch === true,
  };
}

export function readLightningPrefs(): LightningPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...LIGHTNING_PREFS_DEFAULTS };
    const raw = localStorage.getItem(LIGHTNING_PREFS_STORAGE_KEY);
    return raw ? clean(JSON.parse(raw)) : { ...LIGHTNING_PREFS_DEFAULTS };
  } catch {
    return { ...LIGHTNING_PREFS_DEFAULTS };
  }
}

export function writeLightningPrefs(patch: Partial<LightningPrefs>): LightningPrefs {
  const next = clean({ ...readLightningPrefs(), ...patch });
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LIGHTNING_PREFS_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    /* blocked or full storage: the preference lasts this page load only */
  }
  return next;
}
