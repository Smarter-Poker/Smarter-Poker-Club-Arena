/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLINKO BOARD - a Galton board the ball falls through on the server's path
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sixteen rows of chrome pegs on carbon, seventeen lit slots at the foot. The
 * ball never chooses: fn_plinko_drop rolled sixteen bits (one per row, 1 =
 * right) and the ball is drawn bouncing peg to peg along exactly that path,
 * landing in the slot the server paid. The board draws with Canvas 2D and
 * runs on requestAnimationFrame so it can honour the player's Animation Speed
 * (--animation-speed, a duration multiplier) and collapse under reduced motion
 * to a single frame that still shows the path and the landing (CLAUDE.md
 * 10.6: motion collapses, meaning never does).
 *
 * Geometry: row i has i + 1 pegs at x = cx + (j - i / 2) * s. After sixteen
 * decisions the ball sits at cx + (rights - 8) * s, which is slot `rights` of
 * 17 at the foot. Every peg the ball touches lights up as it passes.
 */

import { useEffect, useMemo, useRef } from 'react';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import { soundService } from '../../services/SoundService';
import styles from './PlinkoBoard.module.css';

export const PLINKO_ROWS = 16;
const ROW_MS = 118;
const SLOT_H = 30;
const TOP_PAD = 26;
const SIDE_PAD = 10;

export interface PlinkoBoardProps {
  /** Effective multiplier per slot (cents), after the pool's cap. 17 entries. */
  multipliersCents: number[];
  /** The table's own multiplier per slot, for showing which ones the cap trimmed. */
  tableMultipliersCents?: number[];
  /** The path to animate: 16 bits, row 0 first. null = idle board. */
  path: number[] | null;
  /** Bump to replay a new path. */
  dropKey: number;
  /** The slot the ball rests in when idle after a drop (highlighted). */
  restingSlot: number | null;
  onLanded?: () => void;
  width?: number;
}

function slotColor(cents: number, max: number): { fill: string; glow: string; text: string } {
  if (cents <= 0) return { fill: '#0d1218', glow: 'rgba(0,0,0,0)', text: '#5a6675' };
  const ratio = Math.log(cents / 100 + 1) / Math.log(max / 100 + 1);
  if (ratio > 0.82) return { fill: '#7a1a1a', glow: 'rgba(255,70,70,0.75)', text: '#ffd9d9' };
  if (ratio > 0.6) return { fill: '#7a4d10', glow: 'rgba(255,190,60,0.7)', text: '#ffe7b0' };
  if (ratio > 0.35) return { fill: '#0f4a7a', glow: 'rgba(60,170,255,0.7)', text: '#dff2ff' };
  return { fill: '#12304a', glow: 'rgba(40,120,220,0.5)', text: '#c6dcf0' };
}

export default function PlinkoBoard({
  multipliersCents,
  tableMultipliersCents,
  path,
  dropKey,
  restingSlot,
  onLanded,
  width = 360,
}: PlinkoBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const landedRef = useRef(onLanded);
  landedRef.current = onLanded;
  const animatingRef = useRef(false);
  const latest = useRef({ multipliersCents, tableMultipliersCents, restingSlot, path });
  latest.current = { multipliersCents, tableMultipliersCents, restingSlot, path };

  const geo = useMemo(() => {
    const s = (width - SIDE_PAD * 2) / (PLINKO_ROWS + 1.2);
    const cx = width / 2;
    const rowsHeight = s * PLINKO_ROWS;
    const height = TOP_PAD + rowsHeight + SLOT_H + 18;
    const pegY = (i: number) => TOP_PAD + i * s + s * 0.55;
    const pegX = (i: number, j: number) => cx + (j - i / 2) * s;
    const slotX = (k: number) => cx + (k - 8) * s;
    const slotY = TOP_PAD + rowsHeight + s * 0.35;
    return {
      s,
      cx,
      height,
      pegY,
      pegX,
      slotX,
      slotY,
      pegR: Math.max(2.4, s * 0.16),
      ballR: Math.max(4.5, s * 0.3),
    };
  }, [width]);

  const maxMult = useMemo(
    () => Math.max(100, ...(tableMultipliersCents ?? multipliersCents)),
    [multipliersCents, tableMultipliersCents]
  );

  /**
   * paint(animate): draws the board from the latest props. With animate = true
   * it runs the ball down the given path and calls onLanded once; otherwise it
   * draws one idle frame (the resting slot lit, no ball).
   */
  const paint = (animate: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return () => {};
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};
    const {
      multipliersCents: mults,
      tableMultipliersCents: tableMults,
      restingSlot: resting,
      path: livePath,
    } = latest.current;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(geo.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { s, cx, pegY, pegX, slotX, slotY, pegR, ballR } = geo;
    const bits = animate && livePath && livePath.length === PLINKO_ROWS ? livePath : null;
    const points: Array<{ x: number; y: number }> = [];
    let offset = 0;
    points.push({ x: cx, y: TOP_PAD - ballR });
    if (bits) {
      for (let i = 0; i < PLINKO_ROWS; i++) {
        points.push({ x: cx + offset * s, y: pegY(i) - pegR - ballR });
        offset += bits[i] ? 0.5 : -0.5;
      }
      points.push({ x: cx + offset * s, y: slotY + SLOT_H * 0.45 });
    }
    const litPegs = new Set<string>();

    const drawStatic = (
      highlightSlot: number | null,
      ballAt: { x: number; y: number } | null,
      litUpTo: number
    ) => {
      ctx.clearRect(0, 0, width, geo.height);
      const ground = ctx.createLinearGradient(0, 0, 0, geo.height);
      ground.addColorStop(0, '#05070a');
      ground.addColorStop(1, '#0b1017');
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, width, geo.height);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let k = 0; k <= 16; k++) {
        const x = slotX(k) - s / 2;
        ctx.beginPath();
        ctx.moveTo(x, TOP_PAD);
        ctx.lineTo(x, slotY);
        ctx.stroke();
      }
      for (let i = 0; i < PLINKO_ROWS; i++) {
        for (let j = 0; j <= i; j++) {
          const x = pegX(i, j);
          const y = pegY(i);
          const lit = litPegs.has(`${i}:${j}`) && i <= litUpTo;
          if (lit) {
            ctx.shadowColor = 'rgba(80,190,255,0.95)';
            ctx.shadowBlur = 12;
            ctx.fillStyle = '#9fe0ff';
          } else {
            ctx.shadowColor = 'rgba(0,0,0,0)';
            ctx.shadowBlur = 0;
            const g = ctx.createRadialGradient(
              x - pegR * 0.4,
              y - pegR * 0.4,
              pegR * 0.2,
              x,
              y,
              pegR
            );
            g.addColorStop(0, '#f2f6fa');
            g.addColorStop(0.5, '#9aa8b8');
            g.addColorStop(1, '#3a4756');
            ctx.fillStyle = g;
          }
          ctx.beginPath();
          ctx.arc(x, y, pegR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      /* One size for all seventeen chips, measured, never guessed: the widest
         label sets it, so the row reads as a row instead of collapsing into
         each other at 393px. If the multiplier's own "x" is what stands
         between the row and a legible size it comes off EVERY chip together,
         never off some of them; the odds console under the board carries the
         same figures at full size either way. */
      const slotLabels: string[] = [];
      for (let k = 0; k <= 16; k++) slotLabels.push(multiplierLabel(mults[k] ?? 0));
      const labelRoom = s - 2.5;
      const widest = (labels: string[], f: number) => {
        ctx.font = `800 ${f}px "Roboto Condensed", Inter, sans-serif`;
        return labels.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
      };
      const fitted = (labels: string[]) => {
        const base = s * 0.46;
        const w = widest(labels, base);
        return w > labelRoom ? (base * labelRoom) / w : base;
      };
      let labels = slotLabels;
      let labelPx = fitted(labels);
      if (labelPx < 8) {
        const bare = slotLabels.map((l) => l.replace(/x$/, ''));
        const barePx = fitted(bare);
        if (barePx > labelPx) {
          labels = bare;
          labelPx = barePx;
        }
      }
      labelPx = Math.max(6, labelPx);
      for (let k = 0; k <= 16; k++) {
        const cents = mults[k] ?? 0;
        const table = tableMults?.[k] ?? cents;
        const c = slotColor(table, maxMult);
        const x = slotX(k) - s / 2 + 1;
        const w = s - 2;
        const y = slotY;
        const hot = highlightSlot === k;
        ctx.shadowColor = hot ? 'rgba(255,255,255,0.9)' : c.glow;
        ctx.shadowBlur = hot ? 18 : 8;
        const g = ctx.createLinearGradient(0, y, 0, y + SLOT_H);
        g.addColorStop(0, hot ? '#ffffff' : c.fill);
        g.addColorStop(1, hot ? c.fill : '#05070a');
        ctx.fillStyle = g;
        roundRect(ctx, x, y, w, SLOT_H, 4);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1;
        roundRect(ctx, x + 0.5, y + 0.5, w - 1, SLOT_H - 1, 4);
        ctx.stroke();
        const capped = cents < table;
        ctx.fillStyle = hot ? '#0b1017' : capped ? '#ffd76a' : c.text;
        ctx.font = `800 ${labelPx}px "Roboto Condensed", Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[k], x + w / 2, y + SLOT_H / 2 + 0.5);
      }
      if (ballAt) {
        ctx.shadowColor = 'rgba(90,200,255,0.9)';
        ctx.shadowBlur = 16;
        const g = ctx.createRadialGradient(
          ballAt.x - ballR * 0.35,
          ballAt.y - ballR * 0.35,
          ballR * 0.15,
          ballAt.x,
          ballAt.y,
          ballR
        );
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.45, '#bfe6ff');
        g.addColorStop(1, '#2b7fd6');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(ballAt.x, ballAt.y, ballR, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    };

    if (!bits) {
      drawStatic(resting, null, -1);
      return () => {};
    }

    let off = 0;
    for (let i = 0; i < PLINKO_ROWS; i++) {
      const j = Math.round(off + i / 2);
      litPegs.add(`${i}:${j}`);
      off += bits[i] ? 0.5 : -0.5;
    }
    const landingSlot = bits.reduce((a, b) => a + b, 0);

    const speed = getAnimationSpeed();
    if (prefersReducedMotion()) {
      drawStatic(landingSlot, points[points.length - 1], PLINKO_ROWS);
      animatingRef.current = true;
      const t = setTimeout(() => {
        animatingRef.current = false;
        /* Under reduced motion the fall collapses; the meaning does not. */
        const landedCents = mults[landingSlot] ?? 0;
        if (landedCents >= 1000) soundService.playSpinMultiplierResult(landedCents / 100);
        else if (landedCents > 0) soundService.playWin();
        else soundService.playSpinResult();
        landedRef.current?.();
      }, 200);
      return () => clearTimeout(t);
    }

    const segMs = ROW_MS * speed;
    const total = segMs * (points.length - 1);
    const start = performance.now();
    let done = false;
    animatingRef.current = true;
    /* A PEG IS A SOUND. The ball crosses sixteen rows; each crossing ticks
       once, on the frame the segment index advances, so the rhythm IS the
       fall rather than a loop guessing at it. Same tick the spin ladder
       uses; SoundService throttles and mixes it. */
    let tickedSeg = -1;
    const frame = (now: number) => {
      const t = Math.min(total, now - start);
      const segIndex = Math.min(points.length - 2, Math.floor(t / segMs));
      if (segIndex > tickedSeg) {
        tickedSeg = segIndex;
        if (segIndex > 0) soundService.playSpinTick();
      }
      const u = Math.min(1, (t - segIndex * segMs) / segMs);
      const a = points[segIndex];
      const b = points[segIndex + 1];
      const ey = u * u;
      const x = a.x + (b.x - a.x) * (0.5 - Math.cos(Math.PI * u) / 2);
      const y = a.y + (b.y - a.y) * ey - Math.sin(Math.PI * u) * s * 0.18;
      const finished = t >= total;
      drawStatic(finished ? landingSlot : null, { x, y }, segIndex - 1);
      if (!finished) {
        rafRef.current = requestAnimationFrame(frame);
      } else if (!done) {
        done = true;
        animatingRef.current = false;
        const landedCents = mults[landingSlot] ?? 0;
        if (landedCents >= 1000) soundService.playSpinMultiplierResult(landedCents / 100);
        else if (landedCents > 0) soundService.playWin();
        else soundService.playSpinResult();
        landedRef.current?.();
      }
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      animatingRef.current = false;
    };
  };

  // A new drop: run the ball. Keyed on dropKey alone so a state reload after
  // landing (new caps, new balances) never replays the fall.
  useEffect(() => {
    if (dropKey === 0) return;
    return paint(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropKey]);

  // Idle: redraw when the slots or the resting highlight change, but never
  // over a ball in flight.
  useEffect(() => {
    if (animatingRef.current) return;
    return paint(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multipliersCents, tableMultipliersCents, restingSlot, geo, width, maxMult]);

  return (
    <div className={styles.board} data-motion="keep">
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={{ width, height: geo.height }}
        role="img"
        aria-label="Plinko Board"
      />
    </div>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
