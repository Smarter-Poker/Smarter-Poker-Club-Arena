import { useEffect, useId, useState } from 'react';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import styles from './MinesGrid.module.css';
export function GemArt({ mine = false }: { mine?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={styles.gem}>
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="0" x2=".8" y2="1">
          <stop stopColor={mine ? '#728493' : '#f1ffff'} />
          <stop offset=".42" stopColor={mine ? '#28384b' : '#8ee9ff'} />
          <stop offset="1" stopColor={mine ? '#050910' : '#1a72c7'} />
        </linearGradient>
        <radialGradient id={`${id}b`} cx=".35" cy=".25">
          <stop stopColor="#92a9bb" />
          <stop offset=".4" stopColor="#344557" />
          <stop offset="1" stopColor="#050911" />
        </radialGradient>
      </defs>
      {mine ? (
        <g>
          <g stroke="#9bb4c8" strokeWidth="5" strokeLinecap="round">
            {[0, 45, 90, 135].map((a) => (
              <path key={a} d="M50 13V87" transform={`rotate(${a} 50 50)`} />
            ))}
          </g>
          <circle cx="50" cy="50" r="29" fill={`url(#${id}b)`} stroke="#7b91a6" />
          <path d="M31 38Q37 25 51 26" fill="none" stroke="#d6e7f3" strokeWidth="3" opacity=".7" />
          <circle cx="54" cy="40" r="8" fill="#f96146" />
          <circle cx="52" cy="38" r="3" fill="#ffedd0" />
        </g>
      ) : (
        <g stroke="#caf5ff" strokeWidth=".8" strokeLinejoin="round">
          <path d="M11 35L28 16H72L89 35L50 87Z" fill={`url(#${id}a)`} />
          <path d="M11 35H89L50 87Z" fill="#239bd9" />
          <path d="M11 35L34 37L50 87Z" fill="#64dcff" />
          <path d="M34 37H65L50 87Z" fill="#d6faff" />
          <path d="M65 37L89 35L50 87Z" fill="#2384c8" />
          <path d="M28 16L34 37L11 35Z" fill="#99ebff" />
          <path d="M28 16L50 16L34 37Z" fill="#f4ffff" />
          <path d="M50 16L65 37H34Z" fill="#a5ecff" />
          <path d="M50 16H72L65 37Z" fill="#f4ffff" />
          <path d="M72 16L89 35L65 37Z" fill="#64c9f3" />
          <path d="M20 22L22 14L24 22L32 24L24 26L22 34L20 26L12 24Z" fill="white" stroke="none" />
        </g>
      )}
    </svg>
  );
}
export default function MinesGrid({
  picked,
  mines,
  phase,
  busy,
  onPick,
  onSettled,
  roundId,
}: {
  picked: number[];
  mines: number[] | null;
  phase: 'idle' | 'open' | 'cashed' | 'lost';
  busy: boolean;
  onPick: (cell: number) => void;
  onSettled?: () => void;
  roundId?: string;
}) {
  const terminal = phase === 'cashed' || phase === 'lost';
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return (
    <div
      key={`${roundId}:${phase}`}
      className={styles.board}
      aria-label="Diamond Mines Board"
      data-motion="keep"
      data-terminal={terminal}
      style={
        terminal
          ? {
              animationDuration: `${1800 * getAnimationSpeed()}ms`,
              animationPlayState: visible ? 'running' : 'paused',
            }
          : undefined
      }
      onAnimationEnd={(event) => {
        if (terminal && event.target === event.currentTarget) onSettled?.();
      }}
    >
      <div className={styles.stage}>
        <div className={styles.grid}>
          {Array.from({ length: 25 }, (_, cell) => {
            const mine = mines?.includes(cell) ?? false,
              selected = picked.includes(cell),
              revealed = selected || mines !== null;
            return (
              <button
                key={cell}
                type="button"
                className={styles.tile}
                data-revealed={revealed}
                data-mine={revealed && mine}
                data-picked={selected}
                aria-label={`Tile ${cell + 1}${revealed ? (mine ? ', Mine' : ', Gem') : ''}`}
                disabled={busy || phase !== 'open' || selected}
                onClick={() => onPick(cell)}
              >
                {revealed ? (
                  <GemArt mine={mine} />
                ) : (
                  <>
                    <span className={styles.seal} aria-hidden="true">
                      ◆
                    </span>
                    <span className={styles.number}>{String(cell + 1).padStart(2, '0')}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <p className={styles.caption}>
        {mines
          ? 'Every Mine Is Revealed'
          : phase === 'open'
            ? 'Choose A Tile. Find A Diamond.'
            : '25 Tiles. Your Next Discovery Awaits.'}
      </p>
    </div>
  );
}
