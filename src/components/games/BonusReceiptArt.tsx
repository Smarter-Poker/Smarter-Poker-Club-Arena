import { useId, useState, type CSSProperties } from 'react';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import styles from './BonusReceiptArt.module.css';
import {
  CRASH_MAX_MULTIPLIER,
  receiptBucketTint,
  receiptFigure,
  type BonusReceiptGame,
} from './bonusReceiptFigure';

export type { BonusReceiptGame } from './bonusReceiptFigure';

/** What the small lit line over the figure says, win or loss. */
function caption(game: BonusReceiptGame, dim: boolean, figure: number | null | undefined) {
  if (game === 'crash') return dim ? 'Crashed At' : 'Booked At';
  if (game === 'plinko') return 'Best Bucket';
  if (game === 'mines') return Math.round(Number(figure)) === 1 ? 'Gem Found' : 'Gems Found';
  return dim ? 'Hit At' : 'Made It To';
}

/** One brilliant-cut gem, drawn once per SVG and placed with <use>. */
function Gem({ id, fill, edge }: { id: string; fill: string; edge: string }) {
  return (
    <g id={id}>
      <path d="M-22 -7 L-13 -18 L13 -18 L22 -7 Z" fill={`url(#${fill})`} />
      <path d="M-22 -7 L22 -7 L0 20 Z" fill={`url(#${edge})`} />
      <path d="M-22 -7 L-6 -7 L0 20 Z" fill="#1877f2" opacity="0.55" />
      <path d="M6 -7 L22 -7 L0 20 Z" fill="#e4e7ec" opacity="0.28" />
      <path
        d="M-13 -18 L-6 -7 L0 -18 L6 -7 L13 -18"
        fill="none"
        stroke="#f4f7fb"
        strokeWidth="0.9"
        opacity="0.7"
      />
      <path d="M-22 -7 L22 -7" stroke="#f4f7fb" strokeWidth="1" opacity="0.8" />
      <path
        d="M-22 -7 L-13 -18 L13 -18 L22 -7 L0 20 Z"
        fill="none"
        stroke="#f4f7fb"
        strokeWidth="1.1"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <path d="M-9 -15 L-3 -15 L-7 -9 Z" fill="#f4f7fb" opacity="0.9" />
    </g>
  );
}

/** Crash: the chrome jet at the top of a gold ribbon, at the multiplier it booked. */
function CrashArt({ uid, crown }: { uid: string; crown: boolean }) {
  const ribbon = 'M26 262 C 150 258, 232 196, 292 92';
  return (
    <>
      <defs>
        <linearGradient id={`${uid}gold`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ffa500" />
          <stop offset="1" stopColor="#ffd700" />
        </linearGradient>
        <linearGradient
          id={`${uid}chrome`}
          x1="0"
          y1="-1"
          x2="0"
          y2="1"
          gradientUnits="objectBoundingBox"
        >
          <stop offset="0" stopColor="#f4f7fb" />
          <stop offset="0.45" stopColor="#e4e7ec" />
          <stop offset="0.7" stopColor="#9aa5b3" />
          <stop offset="1" stopColor="#0a1424" />
        </linearGradient>
        <linearGradient id={`${uid}wing`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9aa5b3" />
          <stop offset="1" stopColor="#e4e7ec" />
        </linearGradient>
        <linearGradient id={`${uid}glass`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#45adff" />
          <stop offset="1" stopColor="#06101f" />
        </linearGradient>
        <radialGradient id={`${uid}halo`}>
          <stop offset="0" stopColor={crown ? '#ffd700' : '#45adff'} stopOpacity="0.55" />
          <stop offset="1" stopColor={crown ? '#ffd700' : '#45adff'} stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="#9aa5b3" strokeWidth="1" opacity="0.16">
        <path d="M20 262 H340 M20 212 H340 M20 162 H340 M20 112 H340 M20 62 H340" />
        <path d="M80 40 V262 M160 40 V262 M240 40 V262 M320 40 V262" opacity="0.6" />
      </g>
      <path
        className={styles.ribbonGlow}
        d={ribbon}
        pathLength={1}
        fill="none"
        stroke="#ffd700"
        strokeOpacity="0.28"
        strokeWidth="16"
        strokeLinecap="round"
      />
      <path
        className={styles.ribbon}
        d={ribbon}
        pathLength={1}
        fill="none"
        stroke={`url(#${uid}gold)`}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle
        className={styles.halo}
        cx="292"
        cy="92"
        r={crown ? 70 : 52}
        fill={`url(#${uid}halo)`}
      />
      <g className={styles.jet}>
        <g transform="translate(292 92) rotate(-58)">
          <ellipse cx="-50" cy="0" rx="18" ry="5" fill="#45adff" opacity="0.55" />
          <ellipse cx="-44" cy="0" rx="8" ry="2.6" fill="#f4f7fb" />
          <path
            d="M4 -5 L-20 -34 L-29 -34 L-15 -5 Z"
            fill={`url(#${uid}wing)`}
            stroke="#0a1424"
            strokeWidth="0.8"
          />
          <path
            d="M4 5 L-20 34 L-29 34 L-15 5 Z"
            fill={`url(#${uid}wing)`}
            stroke="#0a1424"
            strokeWidth="0.8"
          />
          <path d="M-27 -5 L-39 -17 L-44 -17 L-37 -4 Z" fill="#9aa5b3" />
          <path d="M-27 5 L-39 17 L-44 17 L-37 4 Z" fill="#9aa5b3" />
          <path
            d="M38 0 C 28 -7, 4 -8.5, -30 -7.5 L-39 -4.5 L-39 4.5 L-30 7.5 C 4 8.5, 28 7, 38 0 Z"
            fill={`url(#${uid}chrome)`}
            stroke="#f4f7fb"
            strokeOpacity="0.6"
            strokeWidth="0.8"
          />
          <ellipse cx="16" cy="0" rx="10" ry="3.6" fill={`url(#${uid}glass)`} />
          <path d="M-20 -3 H22" stroke="#45adff" strokeWidth="1.1" opacity="0.9" />
        </g>
      </g>
      {crown && (
        <g className={styles.crown} transform="translate(292 36)">
          <path
            d="M-24 12 L-28 -12 L-13 0 L0 -18 L13 0 L28 -12 L24 12 Z"
            fill={`url(#${uid}gold)`}
            stroke="#f4f7fb"
            strokeOpacity="0.7"
            strokeWidth="1"
            strokeLinejoin="round"
          />
          <rect x="-24" y="12" width="48" height="6" rx="2" fill="#ffa500" />
          <circle cx="0" cy="-18" r="3" fill="#f4f7fb" />
          <circle cx="-28" cy="-12" r="2.5" fill="#f4f7fb" />
          <circle cx="28" cy="-12" r="2.5" fill="#f4f7fb" />
        </g>
      )}
    </>
  );
}

/** Donkey Cross: the donkey on a lit street sign, the street it reached printed on it. */
function CrossingArt({ uid }: { uid: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}hide`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e4e7ec" />
          <stop offset="0.55" stopColor="#9aa5b3" />
          <stop offset="1" stopColor="#4c5866" />
        </linearGradient>
        <linearGradient id={`${uid}plate`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a1424" />
          <stop offset="1" stopColor="#050607" />
        </linearGradient>
        <linearGradient id={`${uid}post`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#4c5866" />
          <stop offset="0.5" stopColor="#e4e7ec" />
          <stop offset="1" stopColor="#4c5866" />
        </linearGradient>
        <radialGradient id={`${uid}lamp`}>
          <stop offset="0" stopColor="#45adff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#45adff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse
        className={styles.lamp}
        cx="180"
        cy="150"
        rx="170"
        ry="120"
        fill={`url(#${uid}lamp)`}
      />
      <rect x="92" y="246" width="9" height="52" fill={`url(#${uid}post)`} />
      <rect x="259" y="246" width="9" height="52" fill={`url(#${uid}post)`} />
      <g>
        <rect x="46" y="176" width="268" height="74" rx="10" fill="#9aa5b3" />
        <rect x="49" y="179" width="262" height="68" rx="8" fill={`url(#${uid}plate)`} />
        <rect
          className={styles.signLed}
          x="54"
          y="184"
          width="252"
          height="58"
          rx="6"
          fill="none"
          stroke="#45adff"
          strokeWidth="2"
        />
        <path d="M58 186 H302" stroke="#f4f7fb" strokeOpacity="0.18" strokeWidth="1.2" />
      </g>
      <g className={styles.donkey}>
        <ellipse cx="180" cy="178" rx="62" ry="5" fill="#050607" opacity="0.7" />
        <path
          d="M112 118 C 104 128, 100 142, 104 156 C 106 150, 110 144, 114 140"
          fill="none"
          stroke="#4c5866"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="M98 148 C 100 158, 104 166, 110 168 C 110 160, 110 154, 108 148 Z"
          fill="#0a1424"
        />
        <rect x="128" y="138" width="10" height="38" rx="4" fill="#4c5866" />
        <rect x="190" y="138" width="10" height="38" rx="4" fill="#4c5866" />
        <rect x="141" y="138" width="10" height="38" rx="4" fill={`url(#${uid}hide)`} />
        <rect x="203" y="138" width="10" height="38" rx="4" fill={`url(#${uid}hide)`} />
        <rect x="127" y="170" width="12" height="7" rx="2" fill="#0a1424" />
        <rect x="140" y="170" width="12" height="7" rx="2" fill="#0a1424" />
        <rect x="189" y="170" width="12" height="7" rx="2" fill="#0a1424" />
        <rect x="202" y="170" width="12" height="7" rx="2" fill="#0a1424" />
        <ellipse cx="168" cy="128" rx="52" ry="24" fill={`url(#${uid}hide)`} />
        <ellipse cx="170" cy="141" rx="36" ry="8" fill="#e4e7ec" opacity="0.3" />
        <path d="M194 116 Q 202 92 216 72 L 240 84 Q 228 106 222 134 Z" fill={`url(#${uid}hide)`} />
        <path d="M191 113 Q 199 89 213 68 L 219 71 Q 206 92 198 116 Z" fill="#0a1424" />
        <ellipse cx="226" cy="50" rx="5.5" ry="18" fill="#9aa5b3" transform="rotate(-12 226 50)" />
        <ellipse cx="226" cy="51" rx="2.4" ry="13" fill="#0a1424" transform="rotate(-12 226 51)" />
        <ellipse cx="239" cy="51" rx="5.5" ry="18" fill="#9aa5b3" transform="rotate(14 239 51)" />
        <ellipse cx="239" cy="52" rx="2.4" ry="13" fill="#0a1424" transform="rotate(14 239 52)" />
        <ellipse
          cx="240"
          cy="86"
          rx="25"
          ry="13.5"
          fill={`url(#${uid}hide)`}
          transform="rotate(32 240 86)"
        />
        <ellipse cx="256" cy="101" rx="11.5" ry="10" fill="#e4e7ec" />
        <ellipse cx="261" cy="103" rx="2" ry="1.6" fill="#0a1424" />
        <path d="M250 110 Q256 113 263 109" fill="none" stroke="#4c5866" strokeWidth="1.4" />
        <circle cx="237" cy="80" r="3" fill="#050607" />
        <circle cx="238" cy="79" r="1" fill="#f4f7fb" />
      </g>
    </>
  );
}

/** Plinko: the winning bucket's plate lit in its own tint, a diamond landing in it. */
function PlinkoArt({ uid }: { uid: string }) {
  const pegs: Array<[number, number]> = [];
  for (let row = 0; row < 5; row++)
    for (let i = 0; i <= row + 2; i++) pegs.push([180 + (i - (row + 2) / 2) * 30, 40 + row * 28]);
  return (
    <>
      <defs>
        <radialGradient id={`${uid}pool`}>
          <stop offset="0" style={{ stopColor: 'var(--receipt-tint)' }} stopOpacity="0.6" />
          <stop offset="1" style={{ stopColor: 'var(--receipt-tint)' }} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}plate`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a1424" />
          <stop offset="1" stopColor="#050607" />
        </linearGradient>
        <linearGradient id={`${uid}crownFill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4f7fb" />
          <stop offset="1" stopColor="#45adff" />
        </linearGradient>
        <linearGradient id={`${uid}pavilion`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#45adff" />
          <stop offset="1" stopColor="#1877f2" />
        </linearGradient>
        <linearGradient id={`${uid}trail`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#45adff" stopOpacity="0" />
          <stop offset="1" stopColor="#e4e7ec" stopOpacity="0.55" />
        </linearGradient>
        <Gem id={`${uid}gem`} fill={`${uid}crownFill`} edge={`${uid}pavilion`} />
      </defs>
      <g fill="#9aa5b3">
        {pegs.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="3.6" />
        ))}
      </g>
      <g fill="#f4f7fb" opacity="0.8">
        {pegs.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x - 1.1} cy={y - 1.1} r="1.2" />
        ))}
      </g>
      <ellipse
        className={styles.pool}
        cx="180"
        cy="232"
        rx="150"
        ry="62"
        fill={`url(#${uid}pool)`}
      />
      <g>
        <path d="M74 196 L90 196 L96 272 L80 272 Z" fill="#9aa5b3" />
        <path d="M270 196 L286 196 L280 272 L264 272 Z" fill="#9aa5b3" />
        <rect x="84" y="206" width="192" height="68" rx="9" fill="#9aa5b3" />
        <rect x="87" y="209" width="186" height="62" rx="7" fill={`url(#${uid}plate)`} />
        <rect
          className={styles.bucketLed}
          x="92"
          y="214"
          width="176"
          height="52"
          rx="5"
          fill="none"
          style={{ stroke: 'var(--receipt-tint)' }}
          strokeWidth="2.5"
        />
      </g>
      <g className={styles.drop}>
        <rect
          x="174"
          y="70"
          width="12"
          height="96"
          rx="6"
          fill={`url(#${uid}trail)`}
          className={styles.trail}
        />
        <use href={`#${uid}gem`} transform="translate(180 176) scale(1.25)" />
      </g>
      <g className={styles.sparks} fill="#f4f7fb">
        <path d="M128 176 l3 -9 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3 Z" opacity="0.85" />
        <path d="M232 170 l2 -6 l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 Z" opacity="0.7" />
      </g>
    </>
  );
}

/** Mines: the gems the player found, fanned out, the count beneath them. */
function MinesArt({ uid, count }: { uid: string; count: number }) {
  const shown = Math.max(1, Math.min(9, count));
  // Wide enough that three gems read as three, tight enough that nine stay a fan.
  const spread = shown === 1 ? 0 : Math.min(84, 26 * (shown - 1));
  return (
    <>
      <defs>
        <linearGradient id={`${uid}crownFill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4f7fb" />
          <stop offset="1" stopColor="#45adff" />
        </linearGradient>
        <linearGradient id={`${uid}pavilion`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#45adff" />
          <stop offset="1" stopColor="#1877f2" />
        </linearGradient>
        <radialGradient id={`${uid}under`}>
          <stop offset="0" stopColor="#1877f2" stopOpacity="0.5" />
          <stop offset="1" stopColor="#1877f2" stopOpacity="0" />
        </radialGradient>
        <Gem id={`${uid}gem`} fill={`${uid}crownFill`} edge={`${uid}pavilion`} />
      </defs>
      <ellipse cx="180" cy="130" rx="160" ry="100" fill={`url(#${uid}under)`} />
      <g className={styles.sparks} fill="#f4f7fb">
        <path d="M96 70 l3 -9 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3 Z" opacity="0.8" />
        <path d="M262 58 l2 -6 l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 Z" opacity="0.7" />
      </g>
      {Array.from({ length: shown }, (_, i) => {
        const angle = shown === 1 ? 0 : -spread / 2 + (spread * i) / (shown - 1);
        return (
          <g
            key={i}
            className={styles.fanGem}
            style={{ '--fan-angle': `${angle}deg`, '--fan-i': i } as CSSProperties}
          >
            <use href={`#${uid}gem`} transform="translate(180 112) scale(1.6)" />
          </g>
        );
      })}
    </>
  );
}

/**
 * THE RECEIPT WEARS ITS GAME (2026-09-26). Every Diamond bonus game used to end
 * on the same blue chip stack, so a booked 25x flight and a Mines round read as
 * the same event. The receipt keeps everything it says and does; only the
 * picture is the game's own: an original illustration in the house style,
 * drawn here in SVG (no raster asset), with the one number that game is about
 * printed in gold. A loss keeps the receipt's restrained look: the same art,
 * dimmed, and the figure in silver rather than gold.
 *
 * The entrance speaks the reveal's language (a pop, a draw, a landing), every
 * duration scales with Animation Speed, and under reduced motion the art is
 * simply there in its final state.
 */
export function BonusReceiptArt({
  game,
  figure,
  dim = false,
}: {
  game: BonusReceiptGame;
  figure?: number | null;
  /** A lost round: the art stands back and the figure is not gold. */
  dim?: boolean;
}) {
  const uid = `receipt${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [reduced] = useState(() => prefersReducedMotion());
  const [speed] = useState(() => getAnimationSpeed());
  const label = receiptFigure(game, figure);
  const crown = game === 'crash' && !dim && Number(figure) >= CRASH_MAX_MULTIPLIER;
  const cents = Math.round(Number(figure) * 100);
  const style = {
    '--animation-speed': speed,
    '--receipt-tint':
      game === 'plinko' ? receiptBucketTint(Number.isFinite(cents) ? cents : 0) : undefined,
  } as CSSProperties;
  return (
    <div
      className={styles.stage}
      data-receipt-art={game}
      data-dim={dim || undefined}
      data-crown={crown || undefined}
      data-reduced={reduced || undefined}
      style={style}
    >
      <svg className={styles.art} viewBox="0 0 360 300" aria-hidden="true" focusable="false">
        {game === 'crash' ? (
          <CrashArt uid={uid} crown={crown} />
        ) : game === 'crossing' ? (
          <CrossingArt uid={uid} />
        ) : game === 'plinko' ? (
          <PlinkoArt uid={uid} />
        ) : (
          <MinesArt uid={uid} count={Math.round(Number(figure) || 0)} />
        )}
      </svg>
      {label !== null && (
        <span className={styles.figure} data-receipt-figure={game}>
          <span className={styles.caption}>{caption(game, dim, figure)}</span>
          <span className={styles.value}>{label}</span>
        </span>
      )}
    </div>
  );
}
