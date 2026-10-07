/**
 * The variant/format/mode domain a corrective reference, an authority and an
 * inactive candidate are bound to. A domain is read from the original decision
 * snapshot only; nothing here substitutes a default for a missing field, so an
 * unlabelled decision has no domain and cannot be covered.
 */
import { isKnownVariant, KNOWN_VARIANTS } from '../../engine/VariantRules.js';
import type { GameVariant } from '../../types.js';

export const CORRECTIVE_FORMATS = Object.freeze(['cash', 'mtt', 'sng', 'spin', 'hu_sng'] as const);
export type CorrectiveFormat = (typeof CORRECTIVE_FORMATS)[number];
export type CorrectiveMode = 'cash' | 'tournament';

export interface CorrectiveReferenceDomain {
  variant: GameVariant;
  format: CorrectiveFormat;
  /** Derived from the format: cash is cash, every other format is tournament. */
  mode: CorrectiveMode;
}

export const correctiveModeOf = (format: CorrectiveFormat): CorrectiveMode =>
  format === 'cash' ? 'cash' : 'tournament';

/** Exact keys, a known variant, a known format and the mode that format implies. */
export function correctiveDomainIsValid(value: unknown): value is CorrectiveReferenceDomain {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return (
    Object.keys(d).sort().join(',') === 'format,mode,variant' &&
    typeof d.variant === 'string' &&
    isKnownVariant(d.variant) &&
    d.variant === d.variant.toLowerCase() &&
    (CORRECTIVE_FORMATS as readonly unknown[]).includes(d.format) &&
    d.mode === correctiveModeOf(d.format as CorrectiveFormat)
  );
}

/** Stable key, e.g. `nlh-cash` or `plo4-mtt`. */
export const correctiveDomainKey = (d: CorrectiveReferenceDomain): string =>
  `${d.variant}-${d.format}`;

/** Every domain this module can name, in a fixed order (variant, then format). */
export const CORRECTIVE_DOMAINS: readonly CorrectiveReferenceDomain[] = Object.freeze(
  KNOWN_VARIANTS.flatMap((variant) =>
    CORRECTIVE_FORMATS.map((format) =>
      Object.freeze({ variant: variant as GameVariant, format, mode: correctiveModeOf(format) })
    )
  )
);
export const CORRECTIVE_DOMAIN_KEYS: readonly string[] = Object.freeze(
  CORRECTIVE_DOMAINS.map(correctiveDomainKey)
);

/** The original decision's own domain, or null when any part is missing or inconsistent. */
export function correctiveDecisionDomain(gameState: {
  gameVariant?: unknown;
  format?: unknown;
  gameMode?: unknown;
}): CorrectiveReferenceDomain | null {
  const candidate = {
    variant: gameState?.gameVariant,
    format: gameState?.format,
    mode: gameState?.gameMode,
  };
  return correctiveDomainIsValid(candidate) ? candidate : null;
}
