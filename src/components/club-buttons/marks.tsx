/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MARKS - every club icon cut as a lit object, from one recipe
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-09, on the wireframe diamond: "YOU MUST CREATE AND USE DYNAMIC
 * HIGH QUALITY ICON'S WITH DEPTH AND 3D FEEL, NOT WHAT EVER THIS FLAT BORING
 * BROKEN THING IS." The diamond was recut as a faceted stone the same day
 * (ClubButtons.tsx). This is the other fourteen, 2026-09-10, on his "DO ALL
 * OF THIS".
 *
 * ONE RECIPE, FOURTEEN OBJECTS. The console's own emblem language, the one
 * the spade crest and the diamond bezel already speak: a bevelled polished
 * chrome outline, a dark gunmetal body, blue light bouncing off the lower
 * edge, lit from the top left like the plate around it. Every mark is built
 * from the same layers over its own silhouette (marks.json):
 *
 *   1. the extrusion   the silhouette offset down and right, near black: the
 *                      object has thickness and sits in the recess;
 *   2. the body        the silhouette filled gunmetal (or blue glass, for the
 *                      bars of the stats mark) with the chrome rim painted as
 *                      a stroke UNDER the fill, so the rim is a crisp band;
 *   3. the underlight  a radial blue clipped to the silhouette, from below;
 *   4. the groove      a soft black inner line where the face meets the rim,
 *                      so the rim reads as raised, not printed;
 *   5. the sheen       a top-left white wash clipped to the silhouette;
 *   6. the details     chrome pillars, dials, dots and hands, blue lenses.
 *
 * Nothing here is an outline on `fill: none`. What makes it read as three
 * dimensions at 20px is that the rim, the face and the extrusion have three
 * different VALUES, and the light comes from one place.
 *
 * Gradient and clip ids are namespaced per instance (uid), as the diamond's
 * are: two marks on one page with the same ids would have the second steal
 * the first's fills.
 */

import type { ReactNode } from 'react';
import specs from './marks.json';

export type MarkFill = 'chrome' | 'steel' | 'blue' | 'white' | 'none';

interface MarkDetail {
  d: string;
  fill?: MarkFill;
  stroke?: MarkFill;
  width?: number;
  opacity?: number;
}

interface MarkSpec {
  face: 'steel' | 'blue';
  shape: string;
  details: MarkDetail[];
}

export type MarkName = keyof typeof specs;

const SPECS = specs as Record<MarkName, MarkSpec>;

export const MARK_NAMES = Object.keys(SPECS) as MarkName[];

function paint(uid: string, fill: MarkFill | undefined): string {
  switch (fill) {
    case 'chrome':
      return `url(#${uid}-chrome)`;
    case 'steel':
      return `url(#${uid}-steel)`;
    case 'blue':
      return `url(#${uid}-blue)`;
    case 'white':
      return '#ffffff';
    case 'none':
      return 'none';
    default:
      return `url(#${uid}-chrome)`;
  }
}

/** The lit object, defs and layers, without its <svg>: for callers that draw their own. */
export function MarkArt({ name, uid }: { name: MarkName; uid: string }): ReactNode {
  const spec = SPECS[name];
  const id = (k: string) => `${uid}-${k}`;
  return (
    <>
      <defs>
        <linearGradient id={id('chrome')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.28" stopColor="#e3e8ee" />
          <stop offset="0.58" stopColor="#8b97a5" />
          <stop offset="1" stopColor="#46505c" />
        </linearGradient>
        <linearGradient id={id('steel')} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#4a5666" />
          <stop offset="0.5" stopColor="#232c37" />
          <stop offset="1" stopColor="#0f151d" />
        </linearGradient>
        <linearGradient id={id('blue')} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#a6dcff" />
          <stop offset="0.5" stopColor="#3d9ae6" />
          <stop offset="1" stopColor="#0e3f6d" />
        </linearGradient>
        <radialGradient id={id('under')} cx="0.5" cy="1" r="0.75">
          <stop offset="0" stopColor="#4fb8ff" stopOpacity="0.85" />
          <stop offset="0.55" stopColor="#2a7fd0" stopOpacity="0.25" />
          <stop offset="1" stopColor="#2a7fd0" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('sheen')} x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="0.42" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <filter id={id('glow')} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id={id('clip')}>
          <path d={spec.shape} />
        </clipPath>
      </defs>
      <g filter={`url(#${id('glow')})`}>
        {/* 1. the extrusion */}
        <path
          d={spec.shape}
          transform="translate(1.5 2.1)"
          fill="#03060a"
          opacity="0.9"
          stroke="#03060a"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        {/* 2. the body, the chrome rim under it */}
        <path
          d={spec.shape}
          fill={paint(uid, spec.face)}
          stroke={paint(uid, 'chrome')}
          strokeWidth="2.6"
          strokeLinejoin="round"
          paintOrder="stroke"
        />
        {/* 3. the underlight */}
        <rect
          x="0"
          y="0"
          width="64"
          height="64"
          fill={`url(#${id('under')})`}
          clipPath={`url(#${id('clip')})`}
        />
        {/* 4. the groove */}
        <path
          d={spec.shape}
          fill="none"
          stroke="#000000"
          strokeWidth="2.2"
          strokeLinejoin="round"
          opacity="0.5"
          clipPath={`url(#${id('clip')})`}
        />
        {/* 5. the sheen */}
        <rect
          x="0"
          y="0"
          width="64"
          height="64"
          fill={`url(#${id('sheen')})`}
          clipPath={`url(#${id('clip')})`}
        />
        {/* 6. the details */}
        {spec.details.map((det, i) => (
          <path
            key={i}
            d={det.d}
            fill={paint(uid, det.fill ?? 'chrome')}
            stroke={det.stroke ? paint(uid, det.stroke) : undefined}
            strokeWidth={det.stroke ? (det.width ?? 2) : undefined}
            strokeLinecap={det.stroke ? 'round' : undefined}
            strokeLinejoin={det.stroke ? 'round' : undefined}
            opacity={det.opacity}
          />
        ))}
      </g>
    </>
  );
}

export function Mark({ name, uid, className }: { name: MarkName; uid: string; className: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <MarkArt name={name} uid={uid} />
    </svg>
  );
}
