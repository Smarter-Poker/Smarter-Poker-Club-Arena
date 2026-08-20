/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LOBBY ICONS — inline SVG replacements for the lobby's emoji glyphs
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: the club lobby header and the wallet panel drew their icons
 * from emoji — some as JSX string literals (coin, bank, ticket, gem, shield),
 * some as CSS `content:` values (trophy, bar-chart, two-people, chain-link).
 * Three problems with that on a money surface:
 *
 *   1. House rule (CLAUDE.md §5.3 / §3.7): no emoji in source. Bare emoji have
 *      broken the SWC compiler and failed Vercel builds before.
 *   2. Emoji render as the PLATFORM's font — a different picture on iOS,
 *      Android, Windows and Linux, at a different size and baseline each time.
 *      A wallet row's icon column visibly jumped between devices.
 *   3. They cannot inherit the row's colour, so an icon could never signal
 *      state (owed / restricted / reserve) the way the value beside it does.
 *
 * Every icon here is a stroked SVG on `currentColor` at a 24-unit viewBox, so
 * the parent's font-size and colour control it and nothing depends on a font
 * the device may not ship.
 */

import type { ReactElement } from 'react';

interface SvgIconProps {
  size?: number;
  className?: string;
  title?: string;
}

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
    focusable: false as const,
  };
}

/** Events / promotions. Replaces the trophy emoji in the quick-action row. */
export function IconTrophy({ size = 20, className }: SvgIconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6 4h12v5a6 6 0 0 1-12 0V4z" />
      <path d="M6 6H4a2 2 0 0 0 0 4h2" />
      <path d="M18 6h2a2 2 0 0 1 0 4h-2" />
      <path d="M9 20h6M12 15v5" />
    </svg>
  );
}

/** Leaderboard. Replaces the bar-chart emoji. */
export function IconLeaderboard({ size = 20, className }: SvgIconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 20V11M10 20V4M16 20v-6M22 20H2" />
    </svg>
  );
}

/** Member count. Replaces the two-people emoji in the club card meta line. */
export function IconMembers({ size = 14, className }: SvgIconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 3 18.5V20" />
      <circle cx="9" cy="8" r="3.2" />
      <path d="M21 20v-1.5a3.5 3.5 0 0 0-2.7-3.4M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    </svg>
  );
}

/** Share / copy invite link. Replaces the chain-link emoji. */
export function IconShareLink({ size = 15, className }: SvgIconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7" />
      <path d="M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7" />
    </svg>
  );
}

/** Search. */
export function IconSearch({ size = 16, className }: SvgIconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20.5 20.5 16 16" />
    </svg>
  );
}

/** Sort / ordering control on the game action bar. */
export function IconSort({ size = 14, className }: SvgIconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M7 4v16M7 20l-3.2-3.4M7 20l3.2-3.4" />
      <path d="M17 20V4M17 4l-3.2 3.4M17 4l3.2 3.4" />
    </svg>
  );
}

/** Megaphone — the club/union ad strip. */
export function IconMegaphone({ size = 14, className }: SvgIconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3.5 10.5v3a1.5 1.5 0 0 0 1.5 1.5h2l9 4.5V6L7 10.5H5a1.5 1.5 0 0 0-1.5 1.5z" />
      <path d="M19.5 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M7 15v4.5" />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   WALLET ROW ICONS
   Keyed by name so wallet row config stays plain data (no JSX in the table),
   which is what let the old config carry raw emoji strings in the first place.
═══════════════════════════════════════════════════════════════════════════════ */

export type WalletIconName =
  | 'diamond'
  | 'chip'
  | 'bank'
  | 'agent'
  | 'promo'
  | 'treasury'
  | 'rakeback'
  | 'reserve';

/** Diamonds — the global purchasable currency. */
function IconDiamond({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6 3h12l3.5 5.5L12 21 2.5 8.5 6 3z" />
      <path d="M2.5 8.5h19M8.5 8.5 12 21l3.5-12.5M6 3l2.5 5.5M18 3l-2.5 5.5" />
    </svg>
  );
}

/** Chip balance — a poker chip, not a coin. */
function IconChip({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" />
    </svg>
  );
}

/** Club bank / union bank. */
function IconBank({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" />
      <path d="M3 20.5h18" />
    </svg>
  );
}

/** Agent wallet / member-club banks. */
function IconAgent({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1" />
    </svg>
  );
}

/** Promo wallet — a ticket. */
function IconPromo({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 8.5V6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v2a2.5 2.5 0 0 0 0 7v2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-2a2.5 2.5 0 0 0 0-7z" />
      <path d="M14 5v3M14 10.5v3M14 16v3" />
    </svg>
  );
}

/** Rake treasury — funds held in trust. */
function IconTreasury({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 8.8V7M12 17v-1.8" />
    </svg>
  );
}

/** Projected rakeback — money due at the weekly close. */
function IconRakeback({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 17.5 9 11l4 4 7.5-8" />
      <path d="M15.5 3.5h5v5" />
    </svg>
  );
}

/** Backup BBJ — a reserve held behind the main pool. */
function IconReserve({ size, className }: { size: number; className?: string }) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3.2 19.5 6v6c0 4.2-3 7.4-7.5 8.8C7.5 19.4 4.5 16.2 4.5 12V6L12 3.2z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </svg>
  );
}

// React 19 + the new JSX transform: the global `JSX` namespace no longer
// exists, so the return type is spelled with React's own element type.
const WALLET_ICONS: Record<
  WalletIconName,
  (p: { size: number; className?: string }) => ReactElement
> = {
  diamond: IconDiamond,
  chip: IconChip,
  bank: IconBank,
  agent: IconAgent,
  promo: IconPromo,
  treasury: IconTreasury,
  rakeback: IconRakeback,
  reserve: IconReserve,
};

/** Renders a wallet row icon by name. Unknown names render nothing, never a box. */
export function WalletIcon({
  name,
  size = 15,
  className,
}: {
  name: WalletIconName;
  size?: number;
  className?: string;
}) {
  const Cmp = WALLET_ICONS[name];
  if (!Cmp) return null;
  return <Cmp size={size} className={className} />;
}
