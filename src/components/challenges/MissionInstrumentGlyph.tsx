import { useId, type ReactNode } from 'react';
import type { ChallengeType } from '../../services/DailyChallengeService';
import styles from './MissionInstrumentGlyph.module.css';

export type MissionInstrumentGlyphState = 'active' | 'complete' | 'claimed';
export type MissionInstrumentGlyphSize = 'sm' | 'md' | 'lg';

export interface MissionInstrumentGlyphProps {
  type: ChallengeType;
  state?: MissionInstrumentGlyphState;
  progress?: number;
  size?: MissionInstrumentGlyphSize;
  className?: string;
}

const join = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

function MissionMechanism({ type }: { type: ChallengeType }): ReactNode {
  switch (type) {
    case 'hands_played':
      return (
        <g className={styles.cardFan}>
          <path className={styles.darkFill} d="m9.3 14.2 8.8-3.1 5.3 15.1-8.8 3.1Z" />
          <path className={styles.darkFill} d="m21.9 11.1 8.8 3.1-5.3 15.1-8.8-3.1Z" />
          <path className={styles.chromeFill} d="M15.3 10.2h9.4v17.2h-9.4Z" />
          <path
            className={styles.signalFill}
            d="M20 14.1c-1.2 2-3.4 3-3.4 4.9a2.2 2.2 0 0 0 3.4 1.8v2h-2.1M20 20.8a2.2 2.2 0 0 0 3.4-1.8c0-1.9-2.2-2.9-3.4-4.9"
          />
          <path className={styles.microLine} d="M12.1 16.7 14 16M27.9 16.7 26 16" />
        </g>
      );
    case 'hands_won':
      return (
        <g className={styles.crown}>
          <path className={styles.darkFill} d="M11.8 17.1h16.4v11.3H11.8Z" />
          <path className={styles.signalFill} d="m12.6 18.1 2-7 5.4 5.3 5.4-5.3 2 7Z" />
          <path className={styles.signalLine} d="M13.1 21.2h13.8M15.2 24.4h9.6" />
          <path className={styles.chromeLine} d="m16.3 25.3 2.3 2.2 5.2-5.4" />
          <circle className={styles.sensorLight} cx="20" cy="12.2" r="1" />
        </g>
      );
    case 'showdowns':
      return (
        <g className={styles.showdownSpot}>
          <path className={styles.chromeFill} d="m9.5 12.2 8.6-1.5 2.4 14-8.6 1.5Z" />
          <path className={styles.chromeFill} d="m21.9 10.7 8.6 1.5-2.4 14-8.6-1.5Z" />
          <path className={styles.tableLine} d="M8.5 28.5h23" />
          <path className={styles.signalLine} d="M14.6 15.2h1.8M23.6 15.2h1.8" />
          <path
            className={styles.signalLine}
            d="M15.2 20c2.7-2.8 6.9-2.8 9.6 0-2.7 2.8-6.9 2.8-9.6 0Z"
          />
          <circle className={styles.signalFill} cx="20" cy="20" r="1.5" />
        </g>
      );
    case 'showdowns_won':
      return (
        <g className={styles.showdownSpot}>
          <path className={styles.darkFill} d="m9.9 13.3 8.1-2 3.4 13.9-8.1 2Z" />
          <path className={styles.darkFill} d="m22 11.3 8.1 2-3.4 13.9-8.1-2Z" />
          <path className={styles.signalFill} d="m20 12.2 5 5.2-5 7.6-5-7.6Z" />
          <path className={styles.signalLine} d="m15 17.4 5 1.4 5-1.4M20 12.2V25" />
          <path className={styles.chromeLine} d="m23.3 24.9 1.8 1.8 3.7-4" />
        </g>
      );
    case 'hands_won_no_showdown':
      return (
        <g className={styles.hiddenCards}>
          <path className={styles.darkFill} d="m10.1 13.2 8.7-1.8 3.1 14.8-8.7 1.8Z" />
          <path className={styles.darkFill} d="m21.2 11.4 8.7 1.8L26.8 28l-8.7-1.8Z" />
          <path
            className={styles.microLine}
            d="m13.2 15 5.7 10.4M16.9 14.2l4.7 8.6M26.8 15l-5.7 10.4M23.1 14.2l-4.7 8.6"
          />
          <path className={styles.signalLine} d="M10.8 28.4c4.4-3.5 9.1-3.5 13.8 0" />
          <circle className={styles.signalFill} cx="26.8" cy="27.2" r="2.4" />
        </g>
      );
    case 'tournaments_played':
      return (
        <g className={styles.trophy}>
          <path className={styles.chromeFill} d="M14 11.2h12v5.2a6 6 0 0 1-12 0Z" />
          <path
            className={styles.chromeLine}
            d="M14 13.4h-3a3.1 3.1 0 0 0 3.2 5.3M26 13.4h3a3.1 3.1 0 0 1-3.2 5.3M20 22.4v4.2M15.5 29h9"
          />
          <circle className={styles.signalFill} cx="20" cy="16.5" r="2.5" />
          <path className={styles.signalLine} d="M20 14v5M17.5 16.5h5" />
        </g>
      );
    case 'big_pots':
      return (
        <g className={styles.chipLift}>
          <ellipse className={styles.chromeFill} cx="20" cy="12.5" rx="8.2" ry="3" />
          <path
            className={styles.chromeLine}
            d="M11.8 12.5v4.4c0 1.7 3.7 3 8.2 3s8.2-1.3 8.2-3v-4.4M11.8 16.8v4.4c0 1.7 3.7 3 8.2 3s8.2-1.3 8.2-3v-4.4M11.8 21.1v4.4c0 1.7 3.7 3 8.2 3s8.2-1.3 8.2-3v-4.4"
          />
          <path
            className={styles.signalLine}
            d="M16 12.4h8M14.8 17h10.4M14.8 21.3h10.4M14.8 25.6h10.4"
          />
          <circle className={styles.signalFill} cx="20" cy="12.5" r="1.5" />
        </g>
      );
    case 'strong_hands':
      return (
        <g className={styles.strengthMark}>
          <path className={styles.darkFill} d="m8.8 17.3 6.2-5.7 9.7 10.5-6.2 5.7Z" />
          <path className={styles.darkFill} d="m15.8 12 7.4-3.8 6.6 12.6-7.4 3.8Z" />
          <path className={styles.chromeFill} d="M11.8 10.8h8.4v15.6h-8.4Z" />
          <path className={styles.signalFill} d="m17.8 12.5-4 6h3l-1.7 5.9 5.2-7h-3.1Z" />
          <path className={styles.microLine} d="M10.6 18.3 13 16M24 12l2.6 5" />
        </g>
      );
    case 'chips_won':
      return (
        <g className={styles.risingStack}>
          <path
            className={styles.chromeLine}
            d="M9.5 27.8V23h5v4.8M17.5 27.8v-9.6h5v9.6M25.5 27.8V13.4h5v14.4"
          />
          <path className={styles.signalLine} d="M9.4 19.4 17 12l4 3.8 8.6-8.1" />
          <path className={styles.signalLine} d="m25.7 7.7 3.9-.1-.1 3.9" />
          <path
            className={styles.microLine}
            d="M10.2 24.6h3.6M18.2 21h3.6M26.2 17h3.6M26.2 21h3.6M26.2 25h3.6"
          />
        </g>
      );
    case 'friends_added':
      return (
        <g className={styles.networkPulse}>
          <circle className={styles.chromeFill} cx="15.8" cy="15.5" r="3.8" />
          <circle className={styles.chromeFill} cx="25.6" cy="16.8" r="3.1" />
          <path
            className={styles.chromeLine}
            d="M8.9 28.3v-1.2a6.8 6.8 0 0 1 13.6 0v1.2M22.1 22.5a5.7 5.7 0 0 1 8.7 4.8v1"
          />
          <circle className={styles.sensorLight} cx="29.2" cy="11.4" r="3.9" />
          <path className={styles.signalLine} d="M29.2 8.4v6M26.2 11.4h6" />
        </g>
      );
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/** A decorative, progress-aware instrument for a typed Daily Challenges mission. */
export function MissionInstrumentGlyph({
  type,
  state = 'active',
  progress = 0,
  size = 'md',
  className,
}: MissionInstrumentGlyphProps) {
  const faceId = `${useId().replace(/:/g, '')}-mission-face`;
  const boundedProgress = Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;

  return (
    <span
      className={join(styles.root, className)}
      aria-hidden="true"
      data-mission-instrument=""
      data-mission-type={type}
      data-state={state}
      data-size={size}
      data-progress={Math.round(boundedProgress)}
    >
      <svg
        className={styles.svg}
        viewBox="0 0 40 40"
        fill="none"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <radialGradient
            id={faceId}
            cx="0"
            cy="0"
            r="1"
            gradientTransform="translate(14 12) rotate(48) scale(27)"
          >
            <stop stopColor="#1d3d40" />
            <stop offset="0.48" stopColor="#071415" />
            <stop offset="1" stopColor="#010405" />
          </radialGradient>
        </defs>

        <g data-layer="instrument-face">
          <circle className={styles.dialBezel} cx="20" cy="20" r="18" />
          <circle className={styles.dialFace} fill={`url(#${faceId})`} cx="20" cy="20" r="15.7" />
          <circle className={styles.progressTrack} cx="20" cy="20" r="17" pathLength="100" />
          <circle
            className={styles.progressArc}
            cx="20"
            cy="20"
            r="17"
            pathLength="100"
            strokeDasharray={`${boundedProgress} ${100 - boundedProgress}`}
            transform="rotate(-90 20 20)"
          />
          <path className={styles.dialSpecular} d="M8.8 17.2A12.5 12.5 0 0 1 22.6 7.8" />
        </g>

        <g
          className={styles.mechanism}
          data-layer="mission-mechanism"
          data-mission-mechanism={type}
        >
          <MissionMechanism type={type} />
        </g>

        <g className={styles.completionSignal} data-layer="completion-signal">
          <path className={styles.completionRay} d="M7.5 31.2 31.3 7.4" />
          <circle className={styles.statusWell} cx="31" cy="30.8" r="2.25" />
          <circle className={styles.statusLamp} cx="31" cy="30.8" r="1.15" />
        </g>
      </svg>
    </span>
  );
}

export default MissionInstrumentGlyph;
