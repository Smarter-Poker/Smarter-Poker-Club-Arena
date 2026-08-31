/**
 * RESTORING A SAVED TABLE TEMPLATE INTO A FORM THAT AGREES WITH ITSELF.
 *
 * 2026-08-31 audit. `loadTemplate` was one line —
 *   setConfig({ ...DEFAULT_CONFIG, ...template.config, name: '' })
 * — and it was broken four ways, all of which ended with the owner looking at
 * a form that did not describe the table they were about to create:
 *
 *   1. It cleared the name and nothing regenerated it. The naming effect is
 *      guarded by `prev.name ||` and keyed on [gameInfo.name], which a
 *      template load does not change. So both Save and Start bailed on
 *      `!config.name.trim()` immediately after a "Loaded Template" success.
 *   2. It ignored `template.game_type`. The column is written on save and was
 *      read NOWHERE. An MTT template loaded on a variant that cannot run as a
 *      tournament stranded the form in an unreachable mode, and
 *      buildTournamentConfig then fell back to 'NLH' — the owner clicked
 *      Pineapple and got an NLH tournament.
 *   3. The slider index is separate state the load did not touch (see
 *      config/blindsPresets).
 *   4. The seat clamp is an effect keyed on [seatCap, sngSeatCap], neither of
 *      which a template load changes. The header printed "Table Size: 9 max"
 *      on a plo6 page while the write silently clamped to 6.
 *
 * This module is the whole decision, as a pure function, so every branch above
 * is pinned by a test rather than by a reviewer's memory.
 */
import { stakesLabel } from './bettingStructure';
import {
  BLINDS_PRESETS,
  DEFAULT_BLINDS_INDEX,
  blindsIndexFor,
  nearestBlindsIndex,
  type BlindsPreset,
} from '../config/blindsPresets';

/** The fields the restore actually reasons about. */
export interface RestorableTableConfig {
  name: string;
  gameMode: 'regular' | 'sng' | 'mtt';
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  tableSize: number;
}

export interface RestoreArgs<T extends RestorableTableConfig> {
  /** DEFAULT_CONFIG — the floor every restored form starts from. */
  defaults: T;
  /** `table_templates.config` as stored. Trusted for values, not for shape. */
  templateConfig: Partial<T> | null | undefined;
  /** `table_templates.game_type` as stored (upper case variant, or legacy null). */
  templateGameType?: string | null;
  /** The variant this page is building, from the route. */
  routeGameType?: string | null;
  /** GAME_TYPE_LABELS[routeGameType].name — the human name for the table name. */
  gameLabel: string;
  seatCap: number;
  sngSeatCap: number;
  /** canRunAsTournament(routeGameType). */
  canRunAsTournament: boolean;
  /**
   * The ladder THIS variant may be built on — presetsFor(limitGame). A
   * fixed-limit table is offered only the presets where bb === sb * 2; see
   * config/blindsPresets. Defaults to the full ladder.
   */
  presets?: readonly BlindsPreset[];
}

export type RestoreResult<T extends RestorableTableConfig> =
  | { ok: true; config: T; blindsIndex: number; notices: string[] }
  | { ok: false; reason: string };

const normaliseVariant = (v: string | null | undefined): string =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/**
 * Is this template safe to load onto this page?
 *
 * A template records the variant it was built for. Loading a PLO6 template
 * onto an FLH page would carry PLO6's toggles, stakes and seat count onto a
 * fixed-limit table — the exact "promised what it cannot pay" shape the
 * fixed-limit sweep just closed. Templates saved before the column existed
 * (empty game_type) are treated as compatible: refusing them would strand
 * every template an owner already has.
 */
export function templateFitsGame(
  templateGameType: string | null | undefined,
  routeGameType: string | null | undefined
): boolean {
  const saved = normaliseVariant(templateGameType);
  const route = normaliseVariant(routeGameType);
  if (!saved) return true;
  if (!route) return true;
  return saved === route;
}

export function restoreTemplateConfig<T extends RestorableTableConfig>(
  args: RestoreArgs<T>
): RestoreResult<T> {
  const {
    defaults,
    templateConfig,
    templateGameType,
    routeGameType,
    gameLabel,
    seatCap,
    sngSeatCap,
    canRunAsTournament,
    presets = BLINDS_PRESETS,
  } = args;

  if (!templateFitsGame(templateGameType, routeGameType)) {
    return {
      ok: false,
      reason: `That Template Was Saved For ${String(templateGameType).toUpperCase()}. Open That Game To Use It.`,
    };
  }

  const notices: string[] = [];
  const merged: T = { ...defaults, ...(templateConfig || {}) };

  // ── 2. A mode this variant cannot be ──────────────────────────────────
  if (merged.gameMode !== 'regular' && !canRunAsTournament) {
    notices.push(
      `${gameLabel} Cannot Run As A Tournament. The Template Was Loaded As A Cash Game.`
    );
    merged.gameMode = 'regular';
  }

  // ── 3. Blinds and the slider, reconciled ──────────────────────────────
  let blindsIndex = blindsIndexFor(merged.smallBlind, merged.bigBlind, presets);
  if (blindsIndex === null) {
    blindsIndex = Number.isFinite(merged.bigBlind)
      ? nearestBlindsIndex(merged.bigBlind, presets)
      : Math.min(DEFAULT_BLINDS_INDEX, presets.length - 1);
    const preset = presets[blindsIndex];
    notices.push(
      `Blinds ${merged.smallBlind}/${merged.bigBlind} Are No Longer Offered. Snapped To ${preset.label}.`
    );
    merged.smallBlind = preset.sb;
    merged.bigBlind = preset.bb;
  }

  // ── 4. Seats, clamped on load rather than silently at write time ──────
  const clampedMax = Math.max(2, Math.min(merged.maxPlayers, seatCap));
  const clampedTable = Math.max(2, Math.min(merged.tableSize, sngSeatCap));
  if (clampedMax !== merged.maxPlayers || clampedTable !== merged.tableSize) {
    notices.push(`${gameLabel} Seats ${Math.max(clampedMax, clampedTable)} Players At Most.`);
    merged.maxPlayers = clampedMax;
    merged.tableSize = clampedTable;
  }

  // ── 1. A name the owner can actually save with ────────────────────────
  merged.name = defaultTableName(gameLabel, merged.smallBlind, merged.bigBlind, routeGameType);

  return { ok: true, config: merged, blindsIndex, notices };
}

/**
 * The auto-generated table name. Limit games are named by BET size, not blind
 * size, and stakesLabel is the one place that decides — so the name, the
 * stakes column and the lobby row cannot disagree.
 */
export function defaultTableName(
  gameLabel: string,
  smallBlind: number,
  bigBlind: number,
  gameType: string | null | undefined
): string {
  return `${gameLabel} ${stakesLabel(smallBlind, bigBlind, gameType)}`;
}
