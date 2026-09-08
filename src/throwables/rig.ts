/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE RIG — what a throwable DRAWS, in avatar units, knowing nothing
 *  about seats (throwables programme, phase 1)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A rig is two React components:
 *
 *   Projectile  the thing that flies. Drawn once on the thrower (spawn) and
 *               once in flight. The player moves its BOX; the rig may animate
 *               inside it (a spin, a sparking fuse) but never translates it.
 *   Payload     the performance at the target, mounted at LANDING. Everything
 *               timed inside it is `animation-delay` from landing, so a beat
 *               the catalogue gives "from launch" is authored as
 *               (at - flight.ms). The spec's `beats` carry both numbers.
 *
 * THE COORDINATE SYSTEM, fixed for every rig so one darkroom fits all:
 *
 *   - every rig SVG uses viewBox="-150 -150 300 300";
 *   - 100 viewBox units = 1 u = one avatar width at the target seat;
 *   - (0, 0) is the seat's avatar centre for the payload, and the item's own
 *     centre for the projectile;
 *   - the player sizes the SVG element to 3 u, so nothing in the box is ever
 *     clipped: the largest thing in the set (the fireworks group) is 2.4 u.
 *
 * TIME. CSS only, in `calc(<n>s * var(--animation-speed, 1))`, delays
 * included: one variable is the whole Animation Speed law for a rig
 * (CLAUDE.md 10.6). No JS timers inside a rig; the player owns the timers.
 * Keyframe names are prefixed `thr-<id>-` because @keyframes is one global
 * namespace and this app already has ~800 of them.
 *
 * IDS. SVG <defs> ids are global to the document and a multi-table view
 * mounts several rigs at once, so every gradient / filter / clipPath id is
 * built from the `uid` the player passes (`useId()`), never written literally.
 * The knockout learned this; a test pins it here.
 *
 * ART. Approved premium stylized 3D atlases may be drawn through AtlasSprite.
 * Local versioned assets only; no emoji glyphs, no text except a spec'd caption.
 * Everything animates `transform` and `opacity` (a `filter` only where a
 * bloom is the point, and never animated), and no `will-change` anywhere:
 * eight simultaneous throws is the budget and a promoted layer each is a GPU
 * memory bill, not a saving.
 */

import type React from 'react';
import type { AvatarSnapshot } from './avatarSnapshot';

export interface RigProps {
  /** Instance-unique, safe for id attributes. Build every def id from it. */
  uid: string;
  /** Read-only copy of the target from this table, when visible. */
  targetAvatar?: AvatarSnapshot;
}

export interface ThrowableRig {
  /** Only copy-based gags request avatar readback. */
  needsTargetAvatar?: boolean;
  Projectile: React.FC<RigProps>;
  Payload: React.FC<RigProps>;
}

/** The one viewBox. A rig that uses another is caught by the tests. */
export const RIG_VIEWBOX = '-150 -150 300 300';
/** viewBox units per avatar width. */
export const RIG_UNITS_PER_U = 100;
/** Box size, in u, that the player gives every rig SVG. */
export const RIG_BOX_U = 3;
