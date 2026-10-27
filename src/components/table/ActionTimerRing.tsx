import React, { useLayoutEffect, useRef, useState } from 'react';
import { serverNow } from '../../utils/serverClock';

/** Five straight perimeter runs, clockwise from twelve o'clock. The ink
 * counter-translates inside each sliding clip, so its rounded frame never
 * moves or stretches. Only transforms animate; the frame is painted once. */
export function timerPerimeterRuns(width: number, height: number) {
  const w = Math.max(1, width),
    h = Math.max(1, height),
    p = 2 * (w + h);
  return [
    {
      clip: 'polygon(50% 50%,50% 0,100% 0)',
      left: w / 2,
      width: w / 2,
      axis: 'x',
      distance: w / 2,
      start: 0,
      length: w / 2,
    },
    {
      clip: 'polygon(50% 50%,100% 0,100% 100%)',
      left: 0,
      width: w,
      axis: 'y',
      distance: h,
      start: w / 2,
      length: h,
    },
    {
      clip: 'polygon(50% 50%,100% 100%,0 100%)',
      left: 0,
      width: w,
      axis: 'x',
      distance: -w,
      start: w / 2 + h,
      length: w,
    },
    {
      clip: 'polygon(50% 50%,0 100%,0 0)',
      left: 0,
      width: w,
      axis: 'y',
      distance: -h,
      start: 1.5 * w + h,
      length: h,
    },
    {
      clip: 'polygon(50% 50%,0 0,50% 0)',
      left: 0,
      width: w / 2,
      axis: 'x',
      distance: w / 2,
      start: 1.5 * w + 2 * h,
      length: w / 2,
    },
  ].map((run) => ({ ...run, start: run.start / p, length: run.length / p }));
}

export function ActionTimerRing({ timing }: { timing?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 100, h: 50 });
  const paintedAt = useRef(serverNow());
  const [resumeMs, setResumeMs] = useState(0);
  const wasHidden = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      // Layout coordinates, independent of the table's perspective transform.
      const style = getComputedStyle(el);
      const w = parseFloat(style.width),
        h = parseFloat(style.height);
      if (el.getClientRects().length === 0) {
        wasHidden.current = true;
        return;
      }
      if (w > 0 && h > 0) {
        if (wasHidden.current) {
          wasHidden.current = false;
          setResumeMs(Math.max(0, serverNow() - paintedAt.current));
        }
        setSize((old) => (old.w === w && old.h === h ? old : { w, h }));
      }
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const resume = () => {
      if (document.visibilityState !== 'hidden')
        setResumeMs(Math.max(0, serverNow() - paintedAt.current));
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, []);
  const vars = timing as Record<string, string> | undefined;
  const duration = Math.max(0.001, parseFloat(vars?.['--sp-timer-duration'] ?? '15'));
  const delay = parseFloat(vars?.['--sp-timer-delay'] ?? '0') - resumeMs / 1000;
  const controlled =
    vars?.['--timer-progress'] === undefined
      ? null
      : Math.max(0, Math.min(1, parseFloat(vars['--timer-progress']) / 100));
  return (
    <span ref={ref} className="seat__timer-ring" aria-hidden="true">
      <span key={resumeMs} className="seat__timer-ring-arc">
        {timerPerimeterRuns(size.w, size.h).map((run, i) => {
          const x = run.axis === 'x' ? run.distance : 0,
            y = run.axis === 'y' ? run.distance : 0;
          const progress =
            controlled === null
              ? null
              : Math.max(0, Math.min(1, (1 - controlled - run.start) / run.length));
          const wipe =
            progress === null
              ? {}
              : {
                  animationName: 'none',
                  transform: `translate(${x * progress}px,${y * progress}px)`,
                };
          const ink =
            progress === null
              ? {}
              : {
                  animationName: 'none',
                  transform: `translate(${-x * progress}px,${-y * progress}px)`,
                };
          const style = {
            '--sp-segment-duration': `${duration * run.length}s`,
            '--sp-segment-delay': `${delay + duration * run.start}s`,
            '--sp-wipe-x': `${x}px`,
            '--sp-wipe-y': `${y}px`,
            '--sp-counter-x': `${-x}px`,
            '--sp-counter-y': `${-y}px`,
            clipPath: run.clip,
          } as React.CSSProperties;
          return (
            <span key={i} className="seat__timer-sector" style={style}>
              <span
                className="seat__timer-wipe"
                style={{ left: run.left, width: run.width, height: size.h, ...wipe }}
              >
                <span
                  className="seat__timer-ink"
                  style={{ left: -run.left, width: size.w, height: size.h, ...ink }}
                />
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
