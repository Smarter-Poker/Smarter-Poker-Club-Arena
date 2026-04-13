/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE ICONS — Custom SVG Graphics (Club Arena Style)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Custom cartoon-style SVG graphics for throwables.
 * No emojis — all hand-crafted vector graphics.
 */

import React from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
// REACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function ThumbsUpIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Hand */}
      <path
        d="M14 22h4v16h-4a2 2 0 01-2-2V24a2 2 0 012-2z"
        fill="#FFD93D"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      <path
        d="M18 22l4-10a3 3 0 016 0v8h8a4 4 0 014 4v2a10 10 0 01-10 12H18V22z"
        fill="#FFD93D"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Sparkles */}
      <circle cx="36" cy="16" r="2" fill="#FFE066" />
      <circle cx="40" cy="12" r="1.5" fill="#FFE066" />
      <circle cx="34" cy="10" r="1" fill="#FFE066" />
    </svg>
  );
}

export function ClapIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Left hand */}
      <path
        d="M8 28l8-8a3 3 0 014.2 0l6 6-12.2 12.2a3 3 0 01-4.2 0l-1.8-1.8a3 3 0 010-4.2L8 28z"
        fill="#FFD93D"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Right hand */}
      <path
        d="M40 28l-8-8a3 3 0 00-4.2 0l-6 6 12.2 12.2a3 3 0 004.2 0l1.8-1.8a3 3 0 000-4.2L40 28z"
        fill="#FFD93D"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Impact lines */}
      <path
        d="M24 8v6M18 10l2 4M30 10l-2 4"
        stroke="#FF6B6B"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LolIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Face */}
      <circle cx="24" cy="24" r="20" fill="#FFD93D" stroke="#2D2D2D" strokeWidth="2" />
      {/* Eyes (closed, laughing) */}
      <path d="M14 20c2-3 6-3 8 0" stroke="#2D2D2D" strokeWidth="2" strokeLinecap="round" />
      <path d="M26 20c2-3 6-3 8 0" stroke="#2D2D2D" strokeWidth="2" strokeLinecap="round" />
      {/* Mouth (big smile) */}
      <path d="M12 28c4 8 20 8 24 0" fill="#FF6B6B" stroke="#2D2D2D" strokeWidth="2" />
      {/* Tears */}
      <ellipse cx="10" cy="26" rx="3" ry="4" fill="#87CEEB" />
      <ellipse cx="38" cy="26" rx="3" ry="4" fill="#87CEEB" />
    </svg>
  );
}

export function SadIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Face */}
      <circle cx="24" cy="24" r="20" fill="#FFD93D" stroke="#2D2D2D" strokeWidth="2" />
      {/* Eyes */}
      <circle cx="16" cy="20" r="3" fill="#2D2D2D" />
      <circle cx="32" cy="20" r="3" fill="#2D2D2D" />
      {/* Sad mouth */}
      <path
        d="M16 34c4-4 12-4 16 0"
        stroke="#2D2D2D"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      {/* Tears */}
      <path d="M16 24v8" stroke="#87CEEB" strokeWidth="3" strokeLinecap="round" />
      <path d="M32 24v8" stroke="#87CEEB" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function MadIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Face */}
      <circle cx="24" cy="24" r="20" fill="#FF6B6B" stroke="#2D2D2D" strokeWidth="2" />
      {/* Angry eyebrows */}
      <path d="M12 16l8 4" stroke="#2D2D2D" strokeWidth="3" strokeLinecap="round" />
      <path d="M36 16l-8 4" stroke="#2D2D2D" strokeWidth="3" strokeLinecap="round" />
      {/* Eyes */}
      <circle cx="16" cy="22" r="2" fill="#2D2D2D" />
      <circle cx="32" cy="22" r="2" fill="#2D2D2D" />
      {/* Angry mouth */}
      <path d="M16 34h16" stroke="#2D2D2D" strokeWidth="3" strokeLinecap="round" />
      {/* Steam */}
      <path
        d="M6 8c2-4 6-4 8 0M34 8c2-4 6-4 8 0"
        stroke="#FF4444"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// THROWS
// ═══════════════════════════════════════════════════════════════════════════════

export function TomatoIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Tomato body */}
      <ellipse cx="24" cy="28" rx="18" ry="16" fill="#FF4444" stroke="#2D2D2D" strokeWidth="2" />
      {/* Stem */}
      <path d="M24 12v-4" stroke="#4CAF50" strokeWidth="3" strokeLinecap="round" />
      <path d="M20 14c-2-4 0-8 4-8s6 4 4 8" fill="#4CAF50" stroke="#2D2D2D" strokeWidth="1.5" />
      {/* Angry face */}
      <path d="M16 24l4 2" stroke="#2D2D2D" strokeWidth="2" strokeLinecap="round" />
      <path d="M32 24l-4 2" stroke="#2D2D2D" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18" cy="28" r="2" fill="#2D2D2D" />
      <circle cx="30" cy="28" r="2" fill="#2D2D2D" />
      <path
        d="M20 36c2-2 6-2 8 0"
        stroke="#2D2D2D"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      {/* Highlight */}
      <ellipse cx="30" cy="22" rx="4" ry="3" fill="#FF8888" opacity="0.6" />
    </svg>
  );
}

export function EggIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Egg */}
      <ellipse cx="24" cy="26" rx="14" ry="18" fill="#FFFDE7" stroke="#2D2D2D" strokeWidth="2" />
      {/* Cracks */}
      <path d="M18 20l4 6-2 4 3 2" stroke="#BDBDBD" strokeWidth="1.5" fill="none" />
      <path d="M28 18l-2 4 1 6" stroke="#BDBDBD" strokeWidth="1.5" fill="none" />
      {/* Highlight */}
      <ellipse cx="28" cy="18" rx="4" ry="5" fill="#FFFFFF" opacity="0.5" />
    </svg>
  );
}

export function SnowballIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Snowball */}
      <circle cx="24" cy="24" r="18" fill="#E3F2FD" stroke="#90CAF9" strokeWidth="2" />
      {/* Snow texture */}
      <circle cx="18" cy="20" r="3" fill="#FFFFFF" opacity="0.8" />
      <circle cx="30" cy="18" r="4" fill="#FFFFFF" opacity="0.6" />
      <circle cx="24" cy="30" r="5" fill="#FFFFFF" opacity="0.5" />
      {/* Frost sparkles */}
      <circle cx="10" cy="16" r="2" fill="#87CEEB" />
      <circle cx="38" cy="14" r="1.5" fill="#87CEEB" />
      <circle cx="36" cy="32" r="2" fill="#87CEEB" />
    </svg>
  );
}

export function WaterBalloonIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Balloon */}
      <ellipse cx="24" cy="28" rx="16" ry="18" fill="#4FC3F7" stroke="#0288D1" strokeWidth="2" />
      {/* Knot */}
      <path d="M24 10v-4M22 6h4" stroke="#0288D1" strokeWidth="2" strokeLinecap="round" />
      <circle cx="24" cy="10" r="3" fill="#29B6F6" stroke="#0288D1" strokeWidth="1.5" />
      {/* Water shine */}
      <ellipse cx="30" cy="22" rx="4" ry="6" fill="#81D4FA" opacity="0.7" />
      {/* Droplets trail */}
      <circle cx="38" cy="36" r="2" fill="#4FC3F7" />
      <circle cx="42" cy="40" r="1.5" fill="#4FC3F7" />
    </svg>
  );
}

export function PieIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Plate */}
      <ellipse cx="24" cy="38" rx="20" ry="6" fill="#E0E0E0" stroke="#2D2D2D" strokeWidth="2" />
      {/* Pie base */}
      <path d="M8 36c0-12 6-24 16-24s16 12 16 24" fill="#8D6E63" stroke="#2D2D2D" strokeWidth="2" />
      {/* Cream top */}
      <ellipse cx="24" cy="16" rx="12" ry="10" fill="#FFFDE7" stroke="#2D2D2D" strokeWidth="2" />
      {/* Cream swirls */}
      <circle cx="20" cy="14" r="3" fill="#FFFFFF" />
      <circle cx="28" cy="16" r="2.5" fill="#FFFFFF" />
      <circle cx="24" cy="10" r="2" fill="#FFFFFF" />
      {/* Cherry */}
      <circle cx="24" cy="8" r="3" fill="#FF4444" stroke="#2D2D2D" strokeWidth="1" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHEERS
// ═══════════════════════════════════════════════════════════════════════════════

export function BeerIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Mug */}
      <rect
        x="8"
        y="14"
        width="24"
        height="30"
        rx="4"
        fill="#FFB74D"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Handle */}
      <path
        d="M32 20h6a4 4 0 014 4v8a4 4 0 01-4 4h-6"
        fill="none"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Foam */}
      <ellipse cx="20" cy="14" rx="14" ry="6" fill="#FFFDE7" stroke="#2D2D2D" strokeWidth="2" />
      <circle cx="12" cy="12" r="4" fill="#FFFFFF" />
      <circle cx="20" cy="10" r="5" fill="#FFFFFF" />
      <circle cx="28" cy="12" r="3" fill="#FFFFFF" />
      {/* Bubbles */}
      <circle cx="14" cy="26" r="2" fill="#FFE082" opacity="0.6" />
      <circle cx="22" cy="32" r="1.5" fill="#FFE082" opacity="0.6" />
      <circle cx="18" cy="38" r="1" fill="#FFE082" opacity="0.6" />
    </svg>
  );
}

export function ChampagneIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Bottle */}
      <path
        d="M18 44V24c0-2 2-4 2-8V8h8v8c0 4 2 6 2 8v20H18z"
        fill="#1B5E20"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Neck */}
      <rect x="20" y="4" width="8" height="6" fill="#FFD700" stroke="#2D2D2D" strokeWidth="1.5" />
      {/* Cork popping */}
      <ellipse cx="24" cy="2" rx="3" ry="2" fill="#8D6E63" />
      {/* Spray */}
      <path
        d="M24 4l-8-2M24 4l8-2M24 4v-4"
        stroke="#FFD700"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Bubbles */}
      <circle cx="16" cy="8" r="2" fill="#FFE082" />
      <circle cx="32" cy="6" r="1.5" fill="#FFE082" />
      <circle cx="10" cy="4" r="1" fill="#FFE082" />
      <circle cx="38" cy="8" r="1" fill="#FFE082" />
      {/* Label */}
      <rect x="20" y="28" width="8" height="10" fill="#FFD700" rx="1" />
    </svg>
  );
}

export function TrophyIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Cup */}
      <path
        d="M12 8h24v12c0 8-5 14-12 14s-12-6-12-14V8z"
        fill="#FFD700"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Handles */}
      <path d="M12 12H6a4 4 0 000 8h6" fill="none" stroke="#2D2D2D" strokeWidth="2" />
      <path d="M36 12h6a4 4 0 010 8h-6" fill="none" stroke="#2D2D2D" strokeWidth="2" />
      {/* Base */}
      <rect x="20" y="34" width="8" height="4" fill="#FFD700" stroke="#2D2D2D" strokeWidth="1.5" />
      <rect
        x="16"
        y="38"
        width="16"
        height="6"
        rx="2"
        fill="#FFD700"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Star */}
      <path d="M24 14l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1 2-4z" fill="#FFF8E1" />
      {/* Sparkles */}
      <circle cx="8" cy="6" r="2" fill="#FFE082" />
      <circle cx="40" cy="4" r="1.5" fill="#FFE082" />
      <circle cx="44" cy="10" r="1" fill="#FFE082" />
    </svg>
  );
}

export function FireworksIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Center burst */}
      <circle cx="24" cy="20" r="4" fill="#FF4444" />
      {/* Rays */}
      <path d="M24 20l0-14" stroke="#FF4444" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 20l10-10" stroke="#FFD700" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 20l14 0" stroke="#4CAF50" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 20l10 10" stroke="#2196F3" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 20l0 14" stroke="#9C27B0" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 20l-10 10" stroke="#FF9800" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 20l-14 0" stroke="#E91E63" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 20l-10-10" stroke="#00BCD4" strokeWidth="3" strokeLinecap="round" />
      {/* Sparkle dots */}
      <circle cx="24" cy="4" r="2" fill="#FF4444" />
      <circle cx="36" cy="8" r="2" fill="#FFD700" />
      <circle cx="40" cy="20" r="2" fill="#4CAF50" />
      <circle cx="36" cy="32" r="2" fill="#2196F3" />
      <circle cx="24" cy="36" r="2" fill="#9C27B0" />
      <circle cx="12" cy="32" r="2" fill="#FF9800" />
      <circle cx="8" cy="20" r="2" fill="#E91E63" />
      <circle cx="12" cy="8" r="2" fill="#00BCD4" />
    </svg>
  );
}

export function ConfettiIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Party popper */}
      <path d="M8 40l8-32 8 8-16 24z" fill="#FFD700" stroke="#2D2D2D" strokeWidth="2" />
      {/* Confetti pieces */}
      <rect x="20" y="8" width="4" height="6" fill="#FF4444" transform="rotate(15 22 11)" />
      <rect x="28" y="12" width="3" height="5" fill="#4CAF50" transform="rotate(-20 29 14)" />
      <rect x="34" y="8" width="4" height="4" fill="#2196F3" transform="rotate(30 36 10)" />
      <rect x="24" y="18" width="5" height="3" fill="#9C27B0" transform="rotate(-10 26 19)" />
      <rect x="36" y="18" width="3" height="6" fill="#FF9800" transform="rotate(25 37 21)" />
      <rect x="30" y="24" width="4" height="4" fill="#E91E63" transform="rotate(-30 32 26)" />
      <rect x="40" y="14" width="3" height="5" fill="#00BCD4" transform="rotate(10 41 16)" />
      {/* Streamers */}
      <path d="M16 8c4 2 6 8 10 6" stroke="#FF4444" strokeWidth="2" fill="none" />
      <path d="M20 6c6 4 8 10 14 8" stroke="#4CAF50" strokeWidth="2" fill="none" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function CloverIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Four leaves */}
      <ellipse
        cx="18"
        cy="18"
        rx="8"
        ry="10"
        fill="#4CAF50"
        stroke="#2D2D2D"
        strokeWidth="2"
        transform="rotate(-45 18 18)"
      />
      <ellipse
        cx="30"
        cy="18"
        rx="8"
        ry="10"
        fill="#4CAF50"
        stroke="#2D2D2D"
        strokeWidth="2"
        transform="rotate(45 30 18)"
      />
      <ellipse
        cx="18"
        cy="30"
        rx="8"
        ry="10"
        fill="#4CAF50"
        stroke="#2D2D2D"
        strokeWidth="2"
        transform="rotate(45 18 30)"
      />
      <ellipse
        cx="30"
        cy="30"
        rx="8"
        ry="10"
        fill="#4CAF50"
        stroke="#2D2D2D"
        strokeWidth="2"
        transform="rotate(-45 30 30)"
      />
      {/* Stem */}
      <path d="M24 34v10" stroke="#2E7D32" strokeWidth="3" strokeLinecap="round" />
      {/* Center */}
      <circle cx="24" cy="24" r="4" fill="#2E7D32" />
      {/* Sparkle */}
      <circle cx="32" cy="10" r="2" fill="#FFD700" />
      <circle cx="38" cy="16" r="1.5" fill="#FFD700" />
    </svg>
  );
}

export function CardsIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Back card */}
      <rect
        x="8"
        y="8"
        width="24"
        height="32"
        rx="3"
        fill="#1E88E5"
        stroke="#2D2D2D"
        strokeWidth="2"
        transform="rotate(-15 20 24)"
      />
      {/* Middle card */}
      <rect
        x="14"
        y="6"
        width="24"
        height="32"
        rx="3"
        fill="#E53935"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Front card */}
      <rect
        x="20"
        y="8"
        width="24"
        height="32"
        rx="3"
        fill="#FFFFFF"
        stroke="#2D2D2D"
        strokeWidth="2"
        transform="rotate(15 32 24)"
      />
      {/* Card face - Ace */}
      <text x="28" y="26" fontSize="16" fontWeight="bold" fill="#E53935" textAnchor="middle">
        A
      </text>
      <path d="M32 30l-2-4-2 4h-1l3-6 3 6h-1z" fill="#E53935" />
    </svg>
  );
}

export function FishIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Body */}
      <ellipse cx="24" cy="24" rx="16" ry="12" fill="#FF9800" stroke="#2D2D2D" strokeWidth="2" />
      {/* Tail */}
      <path d="M40 24l8-8v16l-8-8z" fill="#FF9800" stroke="#2D2D2D" strokeWidth="2" />
      {/* Fins */}
      <path d="M24 12c-4-6 0-10 0-10s4 4 0 10" fill="#FFB74D" stroke="#2D2D2D" strokeWidth="1.5" />
      <path d="M20 32c-2 4-6 4-6 4s2-4 6-4" fill="#FFB74D" stroke="#2D2D2D" strokeWidth="1.5" />
      {/* Eye */}
      <circle cx="14" cy="22" r="4" fill="#FFFFFF" stroke="#2D2D2D" strokeWidth="1.5" />
      <circle cx="13" cy="22" r="2" fill="#2D2D2D" />
      {/* Mouth */}
      <path d="M6 24c2 2 2 4 0 4" stroke="#2D2D2D" strokeWidth="2" fill="none" />
      {/* Scales pattern */}
      <path
        d="M20 20c2-1 4 0 4 2M24 24c2-1 4 0 4 2M28 20c2-1 4 0 4 2"
        stroke="#E65100"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}

export function SharkIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Body */}
      <ellipse cx="24" cy="28" rx="18" ry="10" fill="#607D8B" stroke="#2D2D2D" strokeWidth="2" />
      {/* Head */}
      <path
        d="M6 28c0-6 6-12 12-12v24c-6 0-12-6-12-12z"
        fill="#607D8B"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Dorsal fin */}
      <path d="M24 18l-4-12 8 0-4 12z" fill="#546E7A" stroke="#2D2D2D" strokeWidth="2" />
      {/* Tail */}
      <path d="M42 28l6-6v12l-6-6z" fill="#546E7A" stroke="#2D2D2D" strokeWidth="2" />
      {/* Eye */}
      <circle cx="12" cy="26" r="3" fill="#FFFFFF" stroke="#2D2D2D" strokeWidth="1" />
      <circle cx="11" cy="26" r="1.5" fill="#2D2D2D" />
      {/* Teeth */}
      <path d="M6 30l2-2 2 2 2-2 2 2" stroke="#FFFFFF" strokeWidth="1.5" fill="none" />
      {/* Gills */}
      <path d="M16 24v8M18 24v8M20 24v8" stroke="#455A64" strokeWidth="1" />
    </svg>
  );
}

export function ChipsIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Bottom chip stack */}
      <ellipse cx="24" cy="40" rx="16" ry="4" fill="#D32F2F" stroke="#2D2D2D" strokeWidth="2" />
      <rect x="8" y="36" width="32" height="4" fill="#D32F2F" />
      <ellipse cx="24" cy="36" rx="16" ry="4" fill="#E53935" stroke="#2D2D2D" strokeWidth="2" />
      {/* Middle chip stack */}
      <ellipse cx="24" cy="32" rx="16" ry="4" fill="#1565C0" stroke="#2D2D2D" strokeWidth="2" />
      <rect x="8" y="28" width="32" height="4" fill="#1565C0" />
      <ellipse cx="24" cy="28" rx="16" ry="4" fill="#1976D2" stroke="#2D2D2D" strokeWidth="2" />
      {/* Top chip stack */}
      <ellipse cx="24" cy="24" rx="16" ry="4" fill="#2E7D32" stroke="#2D2D2D" strokeWidth="2" />
      <rect x="8" y="20" width="32" height="4" fill="#2E7D32" />
      <ellipse cx="24" cy="20" rx="16" ry="4" fill="#388E3C" stroke="#2D2D2D" strokeWidth="2" />
      {/* Flying chip */}
      <ellipse
        cx="36"
        cy="10"
        rx="8"
        ry="3"
        fill="#FFD700"
        stroke="#2D2D2D"
        strokeWidth="2"
        transform="rotate(-20 36 10)"
      />
      {/* Sparkles */}
      <circle cx="42" cy="6" r="2" fill="#FFE082" />
      <circle cx="6" cy="14" r="1.5" fill="#FFE082" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREMIUM
// ═══════════════════════════════════════════════════════════════════════════════

export function DiamondIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Diamond shape */}
      <path d="M24 4l16 12-16 28L8 16l16-12z" fill="#64B5F6" stroke="#2D2D2D" strokeWidth="2" />
      {/* Facets */}
      <path d="M24 4l-8 12h16l-8-12z" fill="#90CAF9" stroke="#2D2D2D" strokeWidth="1" />
      <path d="M8 16l16 28 8-28H8z" fill="#42A5F5" />
      <path d="M24 44l16-28h-8l-8 28z" fill="#1E88E5" />
      {/* Shine */}
      <path d="M12 16l4 8-2 4" stroke="#FFFFFF" strokeWidth="2" opacity="0.6" fill="none" />
      {/* Sparkles */}
      <circle cx="40" cy="8" r="2" fill="#E3F2FD" />
      <circle cx="44" cy="16" r="1.5" fill="#E3F2FD" />
      <circle cx="6" cy="10" r="1.5" fill="#E3F2FD" />
    </svg>
  );
}

export function DragonIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Body */}
      <ellipse cx="28" cy="30" rx="14" ry="10" fill="#4CAF50" stroke="#2D2D2D" strokeWidth="2" />
      {/* Head */}
      <circle cx="16" cy="20" r="10" fill="#4CAF50" stroke="#2D2D2D" strokeWidth="2" />
      {/* Snout */}
      <ellipse cx="8" cy="22" rx="6" ry="4" fill="#66BB6A" stroke="#2D2D2D" strokeWidth="2" />
      {/* Eye */}
      <circle cx="14" cy="18" r="3" fill="#FFEB3B" stroke="#2D2D2D" strokeWidth="1" />
      <circle cx="13" cy="18" r="1.5" fill="#2D2D2D" />
      {/* Horns */}
      <path d="M20 12l4-8M24 14l6-6" stroke="#8D6E63" strokeWidth="3" strokeLinecap="round" />
      {/* Wings */}
      <path d="M28 20c8-12 16-8 16-8l-8 16" fill="#81C784" stroke="#2D2D2D" strokeWidth="2" />
      {/* Fire breath */}
      <path d="M2 22l-2 4 4-2-2 4 4-2" stroke="#FF5722" strokeWidth="2" fill="none" />
      <circle cx="0" cy="24" r="2" fill="#FF9800" />
      {/* Tail */}
      <path
        d="M42 30c4 4 4 10 0 14"
        stroke="#4CAF50"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function LightningIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Lightning bolt */}
      <path
        d="M28 4L12 24h10l-6 20 18-24H24l4-16z"
        fill="#FFD700"
        stroke="#2D2D2D"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Inner highlight */}
      <path d="M26 8l-10 14h6l-4 12" stroke="#FFF8E1" strokeWidth="2" fill="none" />
      {/* Sparkles */}
      <circle cx="8" cy="18" r="2" fill="#FFEB3B" />
      <circle cx="40" cy="28" r="2" fill="#FFEB3B" />
      <circle cx="10" cy="36" r="1.5" fill="#FFEB3B" />
      <circle cx="38" cy="10" r="1.5" fill="#FFEB3B" />
      {/* Electric arcs */}
      <path d="M4 20l4 2-2 4M44 24l-4 2 2 4" stroke="#FFC107" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function WaveIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Wave */}
      <path
        d="M4 32c8-16 16 0 24-16 4-8 12-8 16 0v16H4V32z"
        fill="#1E88E5"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Wave crest */}
      <path d="M4 32c8-16 16 0 24-16" stroke="#64B5F6" strokeWidth="3" fill="none" />
      {/* Foam */}
      <circle cx="16" cy="28" r="3" fill="#E3F2FD" />
      <circle cx="22" cy="24" r="2" fill="#E3F2FD" />
      <circle cx="28" cy="20" r="2.5" fill="#FFFFFF" />
      <circle cx="34" cy="18" r="2" fill="#FFFFFF" />
      {/* Splash drops */}
      <circle cx="38" cy="10" r="2" fill="#64B5F6" />
      <circle cx="42" cy="14" r="1.5" fill="#64B5F6" />
      <circle cx="44" cy="8" r="1" fill="#64B5F6" />
    </svg>
  );
}

export function CrownIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/* Crown base */}
      <path
        d="M6 36h36l-4-20-8 8-6-12-6 12-8-8-4 20z"
        fill="#FFD700"
        stroke="#2D2D2D"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Crown band */}
      <rect
        x="6"
        y="36"
        width="36"
        height="6"
        rx="2"
        fill="#FFC107"
        stroke="#2D2D2D"
        strokeWidth="2"
      />
      {/* Jewels */}
      <circle cx="24" cy="24" r="4" fill="#E53935" stroke="#2D2D2D" strokeWidth="1" />
      <circle cx="14" cy="28" r="3" fill="#1E88E5" stroke="#2D2D2D" strokeWidth="1" />
      <circle cx="34" cy="28" r="3" fill="#4CAF50" stroke="#2D2D2D" strokeWidth="1" />
      {/* Points */}
      <circle cx="10" cy="16" r="2" fill="#FFD700" stroke="#2D2D2D" strokeWidth="1" />
      <circle cx="24" cy="12" r="2" fill="#FFD700" stroke="#2D2D2D" strokeWidth="1" />
      <circle cx="38" cy="16" r="2" fill="#FFD700" stroke="#2D2D2D" strokeWidth="1" />
      {/* Sparkles */}
      <circle cx="4" cy="10" r="2" fill="#FFE082" />
      <circle cx="44" cy="8" r="1.5" fill="#FFE082" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT MAP
// ═══════════════════════════════════════════════════════════════════════════════

export const THROWABLE_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  // Reactions
  'thumbs-up': ThumbsUpIcon,
  clap: ClapIcon,
  lol: LolIcon,
  sad: SadIcon,
  mad: MadIcon,
  // Throws
  tomato: TomatoIcon,
  egg: EggIcon,
  snowball: SnowballIcon,
  'water-balloon': WaterBalloonIcon,
  pie: PieIcon,
  // Cheers
  beer: BeerIcon,
  champagne: ChampagneIcon,
  trophy: TrophyIcon,
  fireworks: FireworksIcon,
  confetti: ConfettiIcon,
  // Expressions
  'good-luck': CloverIcon,
  'nice-hand': CardsIcon,
  fish: FishIcon,
  shark: SharkIcon,
  'all-in': ChipsIcon,
  // Premium
  'diamond-rain': DiamondIcon,
  dragon: DragonIcon,
  lightning: LightningIcon,
  tsunami: WaveIcon,
  crown: CrownIcon,
};

export default THROWABLE_ICONS;
