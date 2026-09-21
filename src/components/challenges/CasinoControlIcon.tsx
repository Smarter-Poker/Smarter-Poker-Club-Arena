import { useId, type ReactNode } from 'react';
import styles from './CasinoControlIcon.module.css';

export const CASINO_CONTROL_ICON_VARIANTS = [
  'ledger',
  'back',
  'retry',
  'alert-on',
  'alert-off',
  'streak',
  'freeze',
  'claim',
  'play',
  'reroll',
  'keep',
  'cancel',
  'confirm',
  'sign-in',
  'continue',
  'sync',
  'cycle-daily',
  'cycle-weekly',
  'cycle-monthly',
] as const;

export type CasinoControlIconVariant = (typeof CASINO_CONTROL_ICON_VARIANTS)[number];

export const CASINO_CONTROL_ICON_STATES = [
  'idle',
  'active',
  'pending',
  'success',
  'attention',
  'error',
  'disabled',
] as const;

export type CasinoControlIconState = (typeof CASINO_CONTROL_ICON_STATES)[number];
export type CasinoControlIconSize = 'sm' | 'md' | 'lg';

export interface CasinoControlIconProps {
  variant: CasinoControlIconVariant;
  state?: CasinoControlIconState;
  size?: CasinoControlIconSize;
  className?: string;
}

const join = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

function AlertMechanism({ off = false }: { off?: boolean }) {
  return (
    <>
      <path
        className={styles.chromeFill}
        d="M15.2 25.8h9.6l-1.5-2.2V18a3.3 3.3 0 0 0-6.6 0v5.6l-1.5 2.2Z"
      />
      <path className={styles.chromeLine} d="M14.5 25.8h11M17.3 25.8a2.7 2.7 0 0 0 5.4 0" />
      <path className={styles.signalLine} d="M20 12.6v-1.8" />
      <path className={styles.pulse} d="M13.9 14.7 12.4 13M26.1 14.7l1.5-1.7" />
      {off ? <path className={styles.cutLine} d="m12.4 11.8 15.2 16.4" /> : null}
    </>
  );
}

function Mechanism({ variant }: { variant: CasinoControlIconVariant }): ReactNode {
  switch (variant) {
    case 'ledger':
      return (
        <>
          <path className={styles.chromeFill} d="M13 11.5h12l3 3v14H13Z" />
          <path
            className={styles.chromeLine}
            d="M25 11.5v3h3M16.3 18h8.3M16.3 21.4h8.3M16.3 24.8h5.2"
          />
          <path className={styles.signalLine} d="m11 15.5-2 1.2v12.8h14" />
          <circle className={styles.signalFill} cx="25.8" cy="26.7" r="2.1" />
        </>
      );
    case 'back':
      return (
        <>
          <path className={styles.chromeLine} d="M28.5 13.3H17.8v-3.1l-7.3 7.2 7.3 7.2v-3.1h8.7" />
          <path className={styles.signalLine} d="M28.5 17.4h-11" />
          <path className={styles.railLine} d="M28.7 10.4v14.2" />
        </>
      );
    case 'retry':
      return (
        <g className={styles.rotor}>
          <path className={styles.chromeLine} d="M27.8 16.2a8.5 8.5 0 1 0 .2 7.2" />
          <path className={styles.signalLine} d="m27.8 11.5.1 5-5-.2" />
          <circle className={styles.signalFill} cx="20" cy="20" r="2.5" />
        </g>
      );
    case 'alert-on':
      return <AlertMechanism />;
    case 'alert-off':
      return <AlertMechanism off />;
    case 'streak':
      return (
        <>
          <path
            className={styles.chromeFill}
            d="m13.2 12.5 4-3.3h5.6l4 3.3 2.2 8.2-3.5 8.1h-11l-3.5-8.1Z"
          />
          <path className={styles.chromeLine} d="M13.2 12.5h13.6M14.5 28.8h11" />
          <g className={styles.streakReactor}>
            <path
              className={styles.signalFill}
              d="M20.2 13.5c2.8 3.5 4.3 5.9 4.3 8.1 0 2.8-1.9 5-4.5 5s-4.5-2.2-4.5-5c0-1.7.9-3.5 2.8-5.8.1 2.2.8 3.2 1.7 3.8-.2-2 .1-4 .2-6.1Z"
            />
            <path
              className={styles.signalLine}
              d="M20 20.1c1.2 1.3 1.8 2.4 1.8 3.3 0 1.1-.8 2-1.8 2s-1.8-.9-1.8-2c0-.8.6-1.9 1.8-3.3Z"
            />
          </g>
          <path className={styles.pulse} d="M9.7 20.7h3M27.3 20.7h3M20 7.4v2.1" />
        </>
      );
    case 'freeze':
      return (
        <>
          <path
            className={styles.chromeFill}
            d="m20 9.4 9 3.5v6.3c0 5.6-3.7 9.6-9 11.5-5.3-1.9-9-5.9-9-11.5v-6.3Z"
          />
          <g className={styles.crystal}>
            <path className={styles.signalLine} d="M20 14v12M14.8 17l10.4 6M14.8 23l10.4-6" />
            <path
              className={styles.signalLine}
              d="m20 14-1.5 1.7M20 14l1.5 1.7M20 26l-1.5-1.7M20 26l1.5-1.7"
            />
          </g>
        </>
      );
    case 'claim':
      return (
        <>
          <path className={styles.signalFill} d="m20 10.7 5.3 5.1-5.3 7.5-5.3-7.5Z" />
          <path className={styles.signalLine} d="m14.7 15.8 5.3 1.5 5.3-1.5M20 10.7v12.6" />
          <path
            className={styles.chromeLine}
            d="M12.2 26.2v2.4h15.6v-2.4M9.8 22.3l2.6 1.3M30.2 22.3l-2.6 1.3"
          />
          <path className={styles.ray} d="M11.2 14.3 8.9 13M28.8 14.3l2.3-1.3M20 8V5.7" />
        </>
      );
    case 'play':
      return (
        <>
          <path
            className={styles.chromeFill}
            d="M11.4 13.2 17 11v17l-5.6-2.2ZM28.6 13.2 23 11v17l5.6-2.2Z"
          />
          <path className={styles.chromeLine} d="M17 11h6v17h-6Z" />
          <path className={styles.signalFill} d="m18.6 15.1 6.2 4.9-6.2 4.9Z" />
          <path className={styles.signalLine} d="M13.7 16.3h1M25.3 23.7h1" />
        </>
      );
    case 'reroll':
      return (
        <g className={styles.rotor}>
          <path
            className={styles.chromeLine}
            d="M12.2 17.4a8.3 8.3 0 0 1 13.4-3.2l1.8 2M27.8 22.6a8.3 8.3 0 0 1-13.4 3.2l-1.8-2"
          />
          <path className={styles.signalLine} d="m26.8 11.5.6 4.7-4.7.6M13.2 28.5l-.6-4.7 4.7-.6" />
          <rect className={styles.chromeFill} x="17" y="17" width="6" height="6" rx="1" />
          <circle className={styles.signalFill} cx="18.8" cy="18.8" r="0.75" />
          <circle className={styles.signalFill} cx="21.2" cy="21.2" r="0.75" />
        </g>
      );
    case 'keep':
      return (
        <>
          <path className={styles.chromeFill} d="M12.3 11.5h15.4v17H12.3Z" />
          <path className={styles.chromeLine} d="M15.8 14.5h8.4v7.8h-8.4Z" />
          <path
            className={styles.signalLine}
            d="M10 22.5c2.6-1.8 5.1-1.6 7.7.6l2.3 2-2 2.7-3.8-2.7"
          />
          <path className={styles.signalLine} d="m19 18 1.7 1.7 3.2-3.3" />
        </>
      );
    case 'cancel':
      return (
        <>
          <path
            className={styles.chromeFill}
            d="m15 10.8 10 .1 4.1 4.1-.1 10-4 4.1-10-.1-4.1-4.1.1-10Z"
          />
          <path className={styles.cutLine} d="m15.6 15.6 8.8 8.8M24.4 15.6l-8.8 8.8" />
        </>
      );
    case 'confirm':
      return (
        <>
          <circle className={styles.chromeFill} cx="20" cy="20" r="9.2" />
          <path className={styles.chromeLine} d="M20 10.8v3M20 26.2v3M10.8 20h3M26.2 20h3" />
          <path className={styles.signalLine} d="m15.1 20 3.1 3.2 6.9-7" />
          <circle className={styles.facetDot} cx="20" cy="20" r="6.2" />
        </>
      );
    case 'sign-in':
      return (
        <>
          <path className={styles.chromeFill} d="M19.5 10.5h8v19h-8Z" />
          <circle className={styles.signalFill} cx="24.7" cy="20" r="0.9" />
          <path className={styles.signalLine} d="M10 20h11.2M17 15.8l4.2 4.2-4.2 4.2" />
          <path className={styles.chromeLine} d="m19.5 10.5-5 2.3v4.1M14.5 23v4.7l5 1.8" />
        </>
      );
    case 'continue':
      return (
        <>
          <path className={styles.railLine} d="M28.8 11.5v17" />
          <path className={styles.chromeFill} d="m12.1 11.8 9 8.2-9 8.2v-5.1H8.8v-6.2h3.3Z" />
          <path className={styles.signalLine} d="m20.4 14.6 5.8 5.4-5.8 5.4" />
        </>
      );
    case 'sync':
      return (
        <g className={styles.rotor}>
          <path
            className={styles.chromeLine}
            d="M11.2 18a9.2 9.2 0 0 1 15.4-4.4l1.7 1.7M28.8 22a9.2 9.2 0 0 1-15.4 4.4l-1.7-1.7"
          />
          <path className={styles.signalLine} d="m27.9 11.3.4 4-4 .4M12.1 28.7l-.4-4 4-.4" />
          <path className={styles.pulse} d="M16.1 20h2.1l1.2-3.1 2 6.2 1.2-3.1h2.1" />
        </g>
      );
    case 'cycle-daily':
      return (
        <g className={styles.cycleDial} data-cycle-mechanism="daily">
          <circle className={styles.chromeLine} cx="20" cy="20" r="9" />
          <circle className={styles.signalFill} cx="20" cy="20" r="1.55" />
          <path className={styles.signalLine} d="M20 20V14.2M20 20l4.2 2.6" />
          <path className={styles.railLine} d="M20 8.4v2.2M20 29.4v2.2M8.4 20h2.2M29.4 20h2.2" />
          <path className={styles.pulse} d="M12.2 11.9 13.8 13.5M26.2 26.5l1.6 1.6" />
        </g>
      );
    case 'cycle-weekly':
      return (
        <g className={styles.cycleWheel} data-cycle-mechanism="weekly">
          <path
            className={styles.chromeLine}
            d="M20 9.2 27.7 13l1.9 8.4-5.3 6.7h-8.6l-5.3-6.7 1.9-8.4Z"
          />
          <circle className={styles.signalLine} cx="20" cy="20" r="5.2" />
          <path
            className={styles.railLine}
            d="M20 9.2v5.6M27.7 13l-4.4 3.5M29.6 21.4l-5.4-1.2M24.3 28.1l-2.4-5.1M15.7 28.1l2.4-5.1M10.4 21.4l5.4-1.2M12.3 13l4.4 3.5"
          />
          <circle className={styles.signalFill} cx="20" cy="20" r="2" />
        </g>
      );
    case 'cycle-monthly':
      return (
        <g className={styles.cycleSeal} data-cycle-mechanism="monthly">
          <path className={styles.chromeFill} d="M11.2 13.2h17.6v16H11.2Z" />
          <path className={styles.chromeLine} d="M11.2 17.2h17.6M15 10.5v5.2M25 10.5v5.2" />
          <path className={styles.signalLine} d="m20 19.2 4.1 4.1L20 28l-4.1-4.7Z" />
          <path className={styles.signalLine} d="m15.9 23.3 4.1 1.2 4.1-1.2M20 19.2V28" />
          <path className={styles.pulse} d="M8.8 24.5h2.4M28.8 24.5h2.4" />
        </g>
      );
    default: {
      const exhaustive: never = variant;
      return exhaustive;
    }
  }
}

/**
 * Decorative artwork for an already-labelled Daily Challenges control or status.
 * Keep the accessible name on the parent button, link, alert, or status element.
 */
export function CasinoControlIcon({
  variant,
  state = 'idle',
  size = 'md',
  className,
}: CasinoControlIconProps) {
  const gradientId = useId().replace(/:/g, '');
  const metalId = `${gradientId}-metal`;
  const glassId = `${gradientId}-glass`;

  return (
    <span
      className={join(styles.root, className)}
      aria-hidden="true"
      data-casino-control-icon=""
      data-variant={variant}
      data-state={state}
      data-size={size}
    >
      <svg
        className={styles.svg}
        viewBox="0 0 40 40"
        fill="none"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={metalId}
            x1="10"
            y1="8"
            x2="30"
            y2="31"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#f4ffff" />
            <stop offset="0.22" stopColor="#789196" />
            <stop offset="0.48" stopColor="#eef8f8" />
            <stop offset="0.7" stopColor="#33484c" />
            <stop offset="1" stopColor="#bcd0d2" />
          </linearGradient>
          <radialGradient
            id={glassId}
            cx="0"
            cy="0"
            r="1"
            gradientTransform="translate(15 12) rotate(48) scale(25)"
          >
            <stop stopColor="#153438" />
            <stop offset="0.52" stopColor="#071718" />
            <stop offset="1" stopColor="#010607" />
          </radialGradient>
        </defs>

        <g data-layer="metal-bezel">
          <path
            className={styles.instrumentPlate}
            fill={`url(#${metalId})`}
            d="M10 3.5h20L36.5 10v20L30 36.5H10L3.5 30V10Z"
          />
          <path
            className={styles.glassPlate}
            fill={`url(#${glassId})`}
            d="M11.7 6.3h16.6l5.4 5.4v16.6l-5.4 5.4H11.7l-5.4-5.4V11.7Z"
          />
          <path className={styles.frameHighlight} d="M6.4 27.4V12l5.6-5.6h15.4" />
          <path className={styles.frameShadow} d="M33.6 12.6V28L28 33.6H12.6" />
          <path className={styles.facetLine} d="M8.2 12.8 12.8 8.2h14.4l4.6 4.6" />
        </g>

        <g className={styles.mechanism} data-layer="mechanism" data-icon-mechanism={variant}>
          <Mechanism variant={variant} />
        </g>

        <g className={styles.instrumentLights} data-layer="instrument-light">
          <circle className={styles.lampWell} cx="29.8" cy="9.8" r="2.35" />
          <circle className={styles.stateLamp} cx="29.8" cy="9.8" r="1.2" />
          <path className={styles.lightSweep} d="M9.5 29.3 29.3 9.5" />
        </g>
      </svg>
    </span>
  );
}

export default CasinoControlIcon;
