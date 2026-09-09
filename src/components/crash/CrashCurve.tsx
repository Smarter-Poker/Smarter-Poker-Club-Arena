/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CRASH CURVE - the multiplier climbing on the server's clock
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The curve is e^(k t) from the round's started_at, k the host's growth
 * constant, t taken from the server's clock (the page keeps an offset from
 * server_now, so the picture agrees with fn_crash_settle's reading to within
 * the round trip). This canvas only DRAWS the multiplier; it never decides
 * anything. When the server says the round crashed the line stops dead at the
 * crash point in red; when it says cashed, the cash-out point is marked in
 * green and the curve keeps a ghost trace of where it went afterwards.
 *
 * Runs on requestAnimationFrame while the round is open; under reduced motion
 * the readout still updates (meaning) but the sweep is redrawn at a lower
 * cadence rather than every frame.
 */

import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../../utils/animationSpeed';
import { crashMultiplierCents, multiplierLabel } from '../../utils/diamondGamesFairness';
import styles from './CrashCurve.module.css';

export type CrashPhase = 'idle' | 'open' | 'cashed' | 'crashed';

export interface CrashCurveProps {
  phase: CrashPhase;
  growthK: number;
  capCents: number;
  /** Server started_at in ms, already translated into the client's clock. */
  startedAtLocalMs: number | null;
  /** Where the round ended (cents), for cashed / crashed. */
  finalCents: number | null;
  /** The point the player cashed at, when cashed. */
  cashoutCents: number | null;
  autoCashoutCents: number | null;
  width?: number;
  height?: number;
  /** Called every frame with the multiplier the curve currently shows. */
  onTick?: (cents: number) => void;
}

const PAD_L = 12;
const PAD_R = 14;
const PAD_T = 18;
const PAD_B = 24;

export default function CrashCurve({
  phase,
  growthK,
  capCents,
  startedAtLocalMs,
  finalCents,
  cashoutCents,
  autoCashoutCents,
  width = 360,
  height = 250,
  onTick,
}: CrashCurveProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const reduced = prefersReducedMotion();
    const plotW = width - PAD_L - PAD_R;
    const plotH = height - PAD_T - PAD_B;

    const draw = (nowCents: number, elapsedMs: number) => {
      ctx.clearRect(0, 0, width, height);
      const ground = ctx.createLinearGradient(0, 0, 0, height);
      ground.addColorStop(0, '#05070a');
      ground.addColorStop(1, '#0b1017');
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, width, height);

      // Axes scale: time grows with the round, the multiplier axis leads the line.
      const tMax = Math.max(6000, elapsedMs * 1.15);
      const mMax = Math.max(2, (nowCents / 100) * 1.25);
      const xOf = (ms: number) => PAD_L + (ms / tMax) * plotW;
      const yOf = (m: number) => PAD_T + plotH - ((m - 1) / (mMax - 1)) * plotH;

      // grid
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.font = '600 10px Inter, "Roboto Condensed", sans-serif';
      ctx.fillStyle = '#5f6d7e';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const mSteps = niceSteps(1, mMax, 4);
      for (const m of mSteps) {
        const y = yOf(m);
        ctx.beginPath();
        ctx.moveTo(PAD_L, y);
        ctx.lineTo(width - PAD_R, y);
        ctx.stroke();
        ctx.fillText(`${m.toFixed(m >= 10 ? 0 : 1)}x`, width - PAD_R - 2, y - 7);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const tSteps = niceSteps(0, tMax / 1000, 5);
      for (const sec of tSteps) {
        if (sec === 0) continue;
        const x = xOf(sec * 1000);
        ctx.beginPath();
        ctx.moveTo(x, PAD_T);
        ctx.lineTo(x, PAD_T + plotH);
        ctx.stroke();
        ctx.fillText(`${sec}s`, x, PAD_T + plotH + 6);
      }

      // auto cash-out line
      if (autoCashoutCents && autoCashoutCents / 100 < mMax) {
        const y = yOf(autoCashoutCents / 100);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255,214,120,0.55)';
        ctx.beginPath();
        ctx.moveTo(PAD_L, y);
        ctx.lineTo(width - PAD_R, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd76a';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Auto ${multiplierLabel(autoCashoutCents)}`, PAD_L + 4, y - 2);
      }

      if (phase === 'idle') return;

      // the curve up to elapsedMs
      const color = phase === 'crashed' ? '#ff5f5f' : phase === 'cashed' ? '#5df2a0' : '#39b6ff';
      const colorSoft =
        phase === 'crashed'
          ? 'rgba(255,95,95,0.28)'
          : phase === 'cashed'
            ? 'rgba(93,242,160,0.26)'
            : 'rgba(57,182,255,0.28)';
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const steps = 120;
      for (let i = 0; i <= steps; i++) {
        const ms = (elapsedMs * i) / steps;
        const m = Math.min(nowCents / 100, Math.exp(growthK * (ms / 1000)));
        const x = xOf(ms);
        const y = yOf(Math.min(m, mMax));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // area under
      ctx.shadowBlur = 0;
      ctx.lineTo(xOf(elapsedMs), PAD_T + plotH);
      ctx.lineTo(PAD_L, PAD_T + plotH);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
      fill.addColorStop(0, colorSoft);
      fill.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fill;
      ctx.fill();

      // the head
      const hx = xOf(elapsedMs);
      const hy = yOf(Math.min(nowCents / 100, mMax));
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(hx, hy, phase === 'open' ? 5 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (phase === 'cashed' && cashoutCents) {
        ctx.fillStyle = '#5df2a0';
        ctx.font = '800 12px "Roboto Condensed", Inter, sans-serif';
        ctx.textAlign = hx > width * 0.6 ? 'right' : 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
          `Cashed Out ${multiplierLabel(cashoutCents)}`,
          hx + (hx > width * 0.6 ? -10 : 10),
          hy - 8
        );
      }
      if (phase === 'crashed') {
        ctx.fillStyle = '#ff5f5f';
        ctx.font = '800 12px "Roboto Condensed", Inter, sans-serif';
        ctx.textAlign = hx > width * 0.6 ? 'right' : 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
          `Crashed At ${multiplierLabel(nowCents)}`,
          hx + (hx > width * 0.6 ? -10 : 10),
          hy - 8
        );
      }
    };

    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    if (phase === 'idle' || startedAtLocalMs === null) {
      draw(100, 0);
      return;
    }

    if (phase !== 'open') {
      const cents = finalCents ?? 100;
      const elapsed = (Math.log(Math.max(1, cents / 100)) / growthK) * 1000;
      draw(cents, elapsed);
      tickRef.current?.(cents);
      return;
    }

    let last = 0;
    const frame = (now: number) => {
      const elapsed = Math.max(0, performance.now() - startedAtLocalMs);
      const cents = crashMultiplierCents(growthK, elapsed, capCents);
      if (!reduced || now - last > 250) {
        last = now;
        draw(cents, elapsed);
        tickRef.current?.(cents);
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [
    phase,
    growthK,
    capCents,
    startedAtLocalMs,
    finalCents,
    cashoutCents,
    autoCashoutCents,
    width,
    height,
  ]);

  return (
    <div className={styles.wrap} data-motion="keep">
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={{ width, height }}
        role="img"
        aria-label="Crash Curve"
      />
    </div>
  );
}

function niceSteps(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 2.5, 5, 10].map((c) => c * pow);
  const step = candidates.find((c) => c >= raw) ?? candidates[candidates.length - 1];
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step)
    out.push(Number(v.toFixed(6)));
  return out;
}
