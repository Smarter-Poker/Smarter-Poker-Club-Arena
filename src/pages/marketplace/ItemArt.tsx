/**
 * MARKETPLACE — Procedural HD Item Art
 * ═══════════════════════════════════════════════════════════════════════════
 * Every marketplace visual is a CUSTOM, DYNAMIC, resolution-independent SVG
 * scene with real depth: a lit stage, a floor shadow, layered geometry,
 * specular highlights and rim light. No flat glyph placeholders, no external
 * image requests, no yellow/brown — smarter.poker palette only (deep navy,
 * cyan #00d4ff, blue #4599ff/#1877f2, violet #a78bfa, green #4ade80).
 *
 * Art is DETERMINISTIC per item: the item id/name hashes to one of the
 * platform accent hues, so two items in the same category still look like
 * themselves on every load, every device, at any DPI (SVG = infinite HD).
 */

import { useId } from 'react';

/* ─── Deterministic hash -> accent selection ─── */

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Platform accents only — no yellow, no brown, ever. */
const ACCENTS = [
  { main: '#00d4ff', deep: '#0284c7', glow: 'rgba(0, 212, 255, 0.55)' },
  { main: '#4599ff', deep: '#1d4ed8', glow: 'rgba(69, 153, 255, 0.55)' },
  { main: '#a78bfa', deep: '#6d28d9', glow: 'rgba(167, 139, 250, 0.55)' },
  { main: '#4ade80', deep: '#15803d', glow: 'rgba(74, 222, 128, 0.5)' },
  { main: '#38bdf8', deep: '#0369a1', glow: 'rgba(56, 189, 248, 0.55)' },
  { main: '#818cf8', deep: '#4338ca', glow: 'rgba(129, 140, 248, 0.55)' },
];

export function accentFor(seed: string) {
  return ACCENTS[hashStr(seed || 'x') % ACCENTS.length];
}

interface ItemArtProps {
  /** Category drives which 3D scene is drawn */
  category?: string | null;
  /** Seed (item id or name) drives the accent hue */
  seed?: string;
  /** Fill the parent (card header) or render at a fixed square size */
  size?: number | 'fill';
  className?: string;
}

/* ─── Shared scene chrome: stage glow + floor shadow ─── */

function Stage({ ids, glow }: { ids: string; glow: string }) {
  return (
    <>
      <radialGradient id={`${ids}-stage`} cx="50%" cy="38%" r="72%">
        <stop offset="0%" stopColor="#22344a" />
        <stop offset="55%" stopColor="#131e2e" />
        <stop offset="100%" stopColor="#0a1018" />
      </radialGradient>
      <radialGradient id={`${ids}-halo`} cx="50%" cy="42%" r="46%">
        <stop offset="0%" stopColor={glow} />
        <stop offset="100%" stopColor="rgba(0,0,0,0)" />
      </radialGradient>
      <radialGradient id={`${ids}-floor`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="rgba(0,0,0,0.55)" />
        <stop offset="100%" stopColor="rgba(0,0,0,0)" />
      </radialGradient>
    </>
  );
}

function SceneBase({ ids }: { ids: string }) {
  return (
    <>
      <rect width="200" height="150" fill={`url(#${ids}-stage)`} />
      <rect width="200" height="150" fill={`url(#${ids}-halo)`} />
      <ellipse cx="100" cy="126" rx="58" ry="11" fill={`url(#${ids}-floor)`} />
    </>
  );
}

/** Common defs: metal body, glass face, rim light. */
function BodyDefs({ ids, main, deep }: { ids: string; main: string; deep: string }) {
  return (
    <>
      <linearGradient id={`${ids}-body`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={main} />
        <stop offset="100%" stopColor={deep} />
      </linearGradient>
      <linearGradient id={`${ids}-metal`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#8fa3b8" />
        <stop offset="45%" stopColor="#42566b" />
        <stop offset="100%" stopColor="#1d2938" />
      </linearGradient>
      <linearGradient id={`${ids}-gloss`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="rgba(255,255,255,0.85)" />
        <stop offset="100%" stopColor="rgba(255,255,255,0)" />
      </linearGradient>
    </>
  );
}

/* ─── Category scenes ─── */

function TimeBankScene({ ids, main }: { ids: string; main: string; deep: string }) {
  return (
    <g>
      {/* Hourglass frame */}
      <rect x="66" y="30" width="68" height="8" rx="4" fill={`url(#${ids}-metal)`} />
      <rect x="66" y="112" width="68" height="8" rx="4" fill={`url(#${ids}-metal)`} />
      <rect x="70" y="36" width="5" height="78" rx="2.5" fill={`url(#${ids}-metal)`} />
      <rect x="125" y="36" width="5" height="78" rx="2.5" fill={`url(#${ids}-metal)`} />
      {/* Glass */}
      <path
        d="M79 40 h42 c0 16 -12 22 -17 30 v10 c5 8 17 14 17 30 h-42 c0 -16 12 -22 17 -30 v-10 c-5 -8 -17 -14 -17 -30 z"
        fill="rgba(160, 210, 255, 0.14)"
        stroke="rgba(200, 230, 255, 0.35)"
        strokeWidth="1.5"
      />
      {/* Glowing sand */}
      <path
        d="M86 44 h28 c-2 10 -10 14 -14 20 c-4 -6 -12 -10 -14 -20 z"
        fill={`url(#${ids}-body)`}
      />
      <path
        d="M84 108 h32 c-3 -9 -12 -13 -16 -18 c-4 5 -13 9 -16 18 z"
        fill={`url(#${ids}-body)`}
      />
      <rect x="99" y="70" width="2.5" height="26" rx="1.25" fill={main} opacity="0.9" />
      {/* Specular */}
      <path
        d="M83 43 c1 10 7 15 10 19 l-4 3 c-5 -6 -8 -13 -8 -22 z"
        fill="rgba(255,255,255,0.35)"
      />
    </g>
  );
}

function TableSkinScene({ ids, main, deep }: { ids: string; main: string; deep: string }) {
  return (
    <g>
      {/* Table base (3D rim) */}
      <ellipse cx="100" cy="86" rx="64" ry="34" fill={`url(#${ids}-metal)`} />
      <ellipse cx="100" cy="82" rx="64" ry="34" fill={deep} />
      <ellipse cx="100" cy="80" rx="56" ry="28" fill={`url(#${ids}-body)`} />
      <ellipse
        cx="100"
        cy="80"
        rx="44"
        ry="20"
        fill="none"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="1.5"
      />
      {/* Felt sheen */}
      <ellipse cx="86" cy="70" rx="30" ry="11" fill="rgba(255,255,255,0.14)" />
      {/* Cards on the felt */}
      <g transform="rotate(-8 100 78)">
        <rect x="88" y="68" width="13" height="18" rx="2" fill="#f1f5f9" />
        <rect
          x="88"
          y="68"
          width="13"
          height="18"
          rx="2"
          fill={`url(#${ids}-gloss)`}
          opacity="0.4"
        />
      </g>
      <g transform="rotate(9 106 80)">
        <rect x="100" y="69" width="13" height="18" rx="2" fill="#e2e8f0" />
        <circle cx="106.5" cy="78" r="3.4" fill={main} />
      </g>
    </g>
  );
}

function ThrowableScene({ ids, main }: { ids: string; main: string; deep: string }) {
  return (
    <g>
      {/* Motion arc */}
      <path
        d="M34 108 C 55 46, 120 34, 158 58"
        fill="none"
        stroke={main}
        strokeOpacity="0.4"
        strokeWidth="3"
        strokeDasharray="2 9"
        strokeLinecap="round"
      />
      {/* Orb projectile with 3D shading */}
      <circle cx="118" cy="72" r="26" fill={`url(#${ids}-body)`} />
      <circle cx="118" cy="72" r="26" fill="rgba(0,0,0,0.18)" />
      <circle cx="112" cy="64" r="22" fill={`url(#${ids}-body)`} />
      <ellipse
        cx="104"
        cy="56"
        rx="9"
        ry="6"
        fill="rgba(255,255,255,0.5)"
        transform="rotate(-24 104 56)"
      />
      {/* Impact spark */}
      <g stroke={main} strokeWidth="2.5" strokeLinecap="round" opacity="0.85">
        <line x1="148" y1="52" x2="156" y2="46" />
        <line x1="152" y1="64" x2="162" y2="64" />
        <line x1="148" y1="76" x2="156" y2="82" />
      </g>
    </g>
  );
}

function EmoteScene({ ids, main }: { ids: string; main: string; deep: string }) {
  return (
    <g>
      {/* Speech bubble with depth */}
      <path
        d="M46 46 h108 a12 12 0 0 1 12 12 v34 a12 12 0 0 1 -12 12 h-64 l-16 16 v-16 h-28 a12 12 0 0 1 -12 -12 v-34 a12 12 0 0 1 12 -12 z"
        fill={`url(#${ids}-body)`}
      />
      <path
        d="M46 46 h108 a12 12 0 0 1 12 12 v8 h-132 v-8 a12 12 0 0 1 12 -12 z"
        fill="rgba(255,255,255,0.22)"
      />
      {/* Face */}
      <circle cx="100" cy="75" r="17" fill="#0d1420" opacity="0.85" />
      <circle cx="94" cy="71" r="2.6" fill={main} />
      <circle cx="106" cy="71" r="2.6" fill={main} />
      <path
        d="M92 80 q8 8 16 0"
        stroke={main}
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="64" cy="75" r="4" fill="rgba(255,255,255,0.5)" />
      <circle cx="136" cy="75" r="4" fill="rgba(255,255,255,0.5)" />
    </g>
  );
}

function AvatarScene({ ids, main, deep }: { ids: string; main: string; deep: string }) {
  return (
    <g>
      {/* Portrait ring */}
      <circle cx="100" cy="78" r="42" fill="none" stroke={`url(#${ids}-body)`} strokeWidth="5" />
      <circle cx="100" cy="78" r="37" fill="#0e1826" />
      {/* Bust with shading */}
      <circle cx="100" cy="66" r="15" fill={`url(#${ids}-body)`} />
      <ellipse
        cx="95"
        cy="60"
        rx="5.5"
        ry="4"
        fill="rgba(255,255,255,0.42)"
        transform="rotate(-20 95 60)"
      />
      <path d="M74 106 a26 22 0 0 1 52 0 z" fill={`url(#${ids}-body)`} />
      <path d="M74 106 a26 22 0 0 1 52 0 z" fill="rgba(0,0,0,0.25)" />
      <path d="M78 100 a22 16 0 0 1 44 0 l0 6 l-44 0 z" fill={deep} opacity="0.65" />
      {/* Rim light */}
      <path
        d="M100 36 a42 42 0 0 1 42 42"
        fill="none"
        stroke={main}
        strokeOpacity="0.6"
        strokeWidth="2"
      />
    </g>
  );
}

function ExclusiveScene({ ids, main, deep }: { ids: string; main: string; deep: string }) {
  return (
    <g>
      {/* Trophy cup with 3D metal shading */}
      <path d="M74 44 h52 v14 a26 26 0 0 1 -52 0 z" fill={`url(#${ids}-body)`} />
      <path d="M74 44 h52 v6 h-52 z" fill="rgba(255,255,255,0.3)" />
      <path d="M74 50 a18 14 0 0 1 -18 8 c0 -12 8 -16 18 -16 z" fill={deep} />
      <path d="M126 50 a18 14 0 0 0 18 8 c0 -12 -8 -16 -18 -16 z" fill={deep} />
      <rect x="95" y="82" width="10" height="14" fill={deep} />
      <path d="M84 96 h32 l4 12 h-40 z" fill={`url(#${ids}-metal)`} />
      <rect x="78" y="108" width="44" height="7" rx="3" fill={`url(#${ids}-metal)`} />
      {/* Gem inset */}
      <circle cx="100" cy="60" r="7" fill="#0d1420" />
      <circle cx="100" cy="60" r="4.5" fill={main} />
      <circle cx="98.5" cy="58.5" r="1.6" fill="rgba(255,255,255,0.8)" />
      {/* Sparkles */}
      <g fill={main} opacity="0.9">
        <path d="M66 36 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" />
        <path d="M138 84 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5 z" />
      </g>
    </g>
  );
}

function DefaultScene({ ids, main, deep }: { ids: string; main: string; deep: string }) {
  return (
    <g>
      {/* Isometric crate */}
      <path d="M100 40 l38 20 v40 l-38 20 l-38 -20 v-40 z" fill={deep} />
      <path d="M100 40 l38 20 -38 20 -38 -20 z" fill={`url(#${ids}-body)`} />
      <path d="M62 60 l38 20 v40 l-38 -20 z" fill="rgba(0,0,0,0.3)" />
      <path d="M138 60 l-38 20 v40 l38 -20 z" fill="rgba(255,255,255,0.1)" />
      <path d="M100 40 l38 20 -38 20 -38 -20 z" fill={`url(#${ids}-gloss)`} opacity="0.25" />
      <circle cx="100" cy="60" r="6" fill="#0d1420" />
      <circle cx="100" cy="60" r="3.6" fill={main} />
    </g>
  );
}

/** Category -> scene renderer */
function sceneFor(category: string | null | undefined) {
  const c = (category || '').toLowerCase();
  if (c.includes('time')) return TimeBankScene;
  if (c.includes('skin') || c.includes('table')) return TableSkinScene;
  if (c.includes('throw')) return ThrowableScene;
  if (c.includes('emote')) return EmoteScene;
  if (c.includes('avatar')) return AvatarScene;
  if (c.includes('exclusive')) return ExclusiveScene;
  return DefaultScene;
}

/** Card / modal artwork for a club shop item. */
export default function ItemArt({ category, seed = '', size = 'fill', className }: ItemArtProps) {
  const ids = useId().replace(/[^a-zA-Z0-9]/g, '');
  const accent = accentFor(`${category || ''}:${seed}`);
  const Scene = sceneFor(category);
  const style =
    size === 'fill'
      ? { width: '100%', height: '100%', display: 'block' as const }
      : { width: size, height: (size * 3) / 4, display: 'block' as const };
  return (
    <svg
      viewBox="0 0 200 150"
      preserveAspectRatio="xMidYMid slice"
      style={style}
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <Stage ids={ids} glow={accent.glow} />
        <BodyDefs ids={ids} main={accent.main} deep={accent.deep} />
      </defs>
      <SceneBase ids={ids} />
      <Scene ids={ids} main={accent.main} deep={accent.deep} />
    </svg>
  );
}

/* ─── Diamond package artwork (Diamonds tab) ─── */

export function DiamondArt({
  tier = 0,
  className,
}: {
  /** 0..7 package index — bigger tiers get bigger, brighter stones */
  tier?: number;
  className?: string;
}) {
  const ids = useId().replace(/[^a-zA-Z0-9]/g, '');
  const scale = 0.72 + Math.min(tier, 7) * 0.05;
  const extra = tier >= 5;
  return (
    <svg
      viewBox="0 0 200 150"
      preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <Stage ids={ids} glow="rgba(0, 212, 255, 0.55)" />
        <linearGradient id={`${ids}-gemTop`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e0f7ff" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id={`${ids}-gemBody`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7dd3fc" />
          <stop offset="55%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <SceneBase ids={ids} />
      <g transform={`translate(100 78) scale(${scale}) translate(-100 -78)`}>
        {/* Crown facets */}
        <path d="M62 62 L82 42 L118 42 L138 62 Z" fill={`url(#${ids}-gemTop)`} />
        <path d="M82 42 L100 62 L118 42 Z" fill="#bae6fd" />
        <path d="M62 62 L100 62 L82 42 Z" fill="#7dd3fc" />
        <path d="M138 62 L100 62 L118 42 Z" fill="#38bdf8" />
        {/* Pavilion */}
        <path d="M62 62 L100 116 L100 62 Z" fill={`url(#${ids}-gemBody)`} />
        <path d="M138 62 L100 116 L100 62 Z" fill="#0284c7" />
        <path d="M62 62 L100 116 L138 62 Z" fill="rgba(255,255,255,0.08)" />
        {/* Specular */}
        <path d="M86 46 L94 46 L78 60 L70 60 Z" fill="rgba(255,255,255,0.75)" />
        <circle cx="100" cy="80" r="2.4" fill="rgba(255,255,255,0.7)" />
      </g>
      {extra && (
        <g fill="#7dd3fc" opacity="0.95">
          <path d="M52 44 l2.4 6 6 2.4 -6 2.4 -2.4 6 -2.4 -6 -6 -2.4 6 -2.4 z" />
          <path d="M150 96 l1.8 4.6 4.6 1.8 -4.6 1.8 -1.8 4.6 -1.8 -4.6 -4.6 -1.8 4.6 -1.8 z" />
        </g>
      )}
    </svg>
  );
}

/* ─── VIP plan artwork (Membership tab) ─── */

export function VipArt({
  variant = 'monthly',
  className,
}: {
  variant?: 'daily' | 'monthly' | 'annual';
  className?: string;
}) {
  const ids = useId().replace(/[^a-zA-Z0-9]/g, '');
  const accent =
    variant === 'annual'
      ? { main: '#a78bfa', deep: '#6d28d9', glow: 'rgba(167, 139, 250, 0.55)' }
      : variant === 'monthly'
        ? { main: '#00d4ff', deep: '#0284c7', glow: 'rgba(0, 212, 255, 0.55)' }
        : { main: '#4599ff', deep: '#1d4ed8', glow: 'rgba(69, 153, 255, 0.5)' };
  return (
    <svg
      viewBox="0 0 200 150"
      preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <Stage ids={ids} glow={accent.glow} />
        <BodyDefs ids={ids} main={accent.main} deep={accent.deep} />
      </defs>
      <SceneBase ids={ids} />
      <g>
        {/* Shield with bevel */}
        <path
          d="M100 34 l40 12 v34 c0 22 -18 36 -40 44 c-22 -8 -40 -22 -40 -44 v-34 z"
          fill={`url(#${ids}-body)`}
        />
        <path
          d="M100 40 l33 10 v29 c0 18 -15 30 -33 37 c-18 -7 -33 -19 -33 -37 v-29 z"
          fill="#0e1826"
        />
        <path d="M100 34 l40 12 v6 l-40 -12 -40 12 v-6 z" fill="rgba(255,255,255,0.28)" />
        {/* Crown */}
        <path d="M78 84 l6 -18 10 10 6 -16 6 16 10 -10 6 18 z" fill={`url(#${ids}-body)`} />
        <rect x="78" y="84" width="44" height="7" rx="2.5" fill={accent.deep} />
        <circle cx="84.5" cy="64" r="2.6" fill={accent.main} />
        <circle cx="100" cy="58" r="2.6" fill={accent.main} />
        <circle cx="115.5" cy="64" r="2.6" fill={accent.main} />
        {/* Rim light */}
        <path d="M100 34 l40 12" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" fill="none" />
      </g>
    </svg>
  );
}
