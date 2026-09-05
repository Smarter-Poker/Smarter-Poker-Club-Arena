/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD PRESENTATION ENGINE — shared types
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * RIVER SQUEEZE 2026-09-04. A presentation layer around the AUTHORITATIVE board.
 * The Hetzner engine decides that a street exists, which card it is and when
 * the hand moves on; the client only decides how the card is SHOWN. Nothing in
 * this module may read or write poker state, and nothing in poker state may
 * wait on anything here (CLAUDE.md 10.6: animations always play, and they are
 * never part of game logic).
 *
 * The first specialised animation is the river squeeze, measured frame by
 * frame from the reference recording (RIVER SQUEEZE ANIMATION.MOV, 30fps):
 *
 *   frames 155-288   the river arrives FACE DOWN in the already-reserved fifth
 *                    slot and holds there (the board never shifts);
 *   frame 289  +0ms  the back starts compressing horizontally - a dark edge
 *                    appears on the left, so it is a rotateY flip, not a scaleX
 *                    squash;
 *   frame 290 +33ms  the back is a ~25%-wide sliver, still showing the back;
 *   frame 291 +66ms  the face is at ~100% width - the edge-on point and the
 *                    face expansion fell between two captured frames;
 *   frames 292-293   a slight settle, then static.
 *
 * So the reveal itself is a ~100-130ms snap, back -> sliver -> face, preceded
 * by a deliberate face-down hold. The hold is the tension; the squeeze is the
 * flip. Every profile is those five beats with different lengths.
 */

export type CardPresentationMode = 'cash' | 'tournament' | 'lightning' | 'replay' | 'spectator';

export type CardPresentationPlatform = 'desktop' | 'tablet' | 'mobile';

/**
 * FULL     everything the profile allows (3D flip, overshoot, sweep)
 * COMPACT  shorter, minimal effects - background tables, lightning
 * REDUCED  prefers-reduced-motion: no 3D, no overshoot, no sweep; the board
 *          is simply correct (CLAUDE.md 10.6: motion collapses, meaning never)
 * OFF      the table is not on screen at all (a hidden multi-table slot, or
 *          an interrupt path). The final card renders instantly.
 *
 * OFF is NEVER a user toggle. CLAUDE.md 10.6 forbids any toggle that disables
 * an animation outright; --animation-speed is the only sanctioned control.
 * The resolver only ever returns OFF for a table nobody can see or for the
 * cancel path, where "render the authoritative board" is the whole job.
 */
export type CardPresentationIntensity = 'full' | 'compact' | 'reduced' | 'off';

export type CommunityStreet = 'flop' | 'turn' | 'river';

export type CardPresentationFocus = 'focused' | 'visible' | 'hidden';

/**
 * One immutable timing profile. All durations are BASE milliseconds at
 * animation speed 1; the CSS multiplies by var(--animation-speed) and the JS
 * windows by getAnimationSpeed(), which is the same multiplier, so a slowed
 * table never has its markup torn out mid-flip.
 */
export interface CardAnimationProfile {
  readonly id: string;
  readonly mode: CardPresentationMode;
  readonly platform: CardPresentationPlatform;
  readonly intensity: CardPresentationIntensity;
  /** Face-down card materialises in the reserved slot (opacity + slight scale). */
  readonly prepareMs: number;
  /** Face-down hold. The video's tension beat; 0 on a normal street. */
  readonly holdMs: number;
  /** Back compresses to the edge (rotateY 0 -> 90). */
  readonly squeezeMs: number;
  /** Face expands from the edge (rotateY 90 -> 180). */
  readonly revealMs: number;
  /** Micro-overshoot and rest. */
  readonly settleMs: number;
  /** Total of the five beats. Always equal to their sum (asserted by tests). */
  readonly durationMs: number;
  /** Peak scale of the settle overshoot; 1 = none. Never above 1.04. */
  readonly overshoot: number;
  /** Second-board offset for double/triple-board hands. */
  readonly staggerMs: number;
  readonly audioEnabled: boolean;
  readonly lightSweepEnabled: boolean;
  /** rotateY flip with two surfaces (true) or a flat crossfade (false). */
  readonly threeD: boolean;
}

export interface ResolveProfileInput {
  readonly mode: CardPresentationMode;
  readonly platform: CardPresentationPlatform;
  readonly focus: CardPresentationFocus;
  readonly reducedMotion: boolean;
  /** An all-in runout: the server paces the streets, the card holds face down. */
  readonly allIn: boolean;
}

/**
 * What the board hands the engine when a community card has been dealt. This
 * is derived from the authoritative snapshot - never from a server "animation
 * instruction", which does not exist and must not be added (spec 26).
 */
export interface CommunityCardDealPresentation {
  readonly tableId: string;
  /** hand_number from the engine snapshot; monotonic per table. */
  readonly handId: string | number;
  /** 0 = board 1, 1 = board 2, 2 = board 3 (bomb pots) or RIT run index. */
  readonly boardIndex: number;
  readonly street: CommunityStreet;
  /** Board slot the card lands in (4 for the river). */
  readonly slotIndex: number;
  /** Ordering hint inside the hand; visibleCount is fine. */
  readonly sequence: number;
}

export type CardPresentationPhase =
  | 'idle'
  | 'prepare'
  | 'hold'
  | 'squeeze'
  | 'reveal'
  | 'settle'
  | 'complete'
  | 'cancelled';

export type PresentStatus = 'started' | 'instant' | 'duplicate' | 'stale';

export interface PresentResult {
  readonly status: PresentStatus;
  readonly key: string;
  readonly profile: CardAnimationProfile;
  /** Base (speed-1) milliseconds the markup must stay mounted. */
  readonly durationMs: number;
}

export type CardPresentationTelemetryEvent =
  | 'animation_started'
  | 'animation_completed'
  | 'animation_cancelled'
  | 'animation_skipped'
  | 'animation_duplicate_ignored'
  | 'animation_performance_degraded';

export interface CardPresentationTelemetry {
  readonly event: CardPresentationTelemetryEvent;
  readonly key: string;
  readonly street: CommunityStreet;
  readonly boardIndex: number;
  readonly profile: string;
  readonly platform: CardPresentationPlatform;
  readonly mode: CardPresentationMode;
  readonly durationExpected: number;
  readonly durationActual?: number;
  readonly reason?: string;
}

export type TelemetrySink = (t: CardPresentationTelemetry) => void;

export interface PhaseChange {
  readonly key: string;
  readonly phase: CardPresentationPhase;
  readonly elapsedMs: number;
}

export type PhaseListener = (change: PhaseChange) => void;
