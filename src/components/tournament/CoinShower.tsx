/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COIN SHOWER — slot-machine jackpot payout, on a canvas
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "THE CHEST SHOULD EXPLODE WITH COINS LIKE A COIN SHOWER WHEN
 * YOU HIT A JACKPOT ON A SLOT MACHINE."
 *
 * The old chest threw 18 DOM spans on CSS transitions. That reads as cheap for
 * two reasons: eighteen of anything is countable, and a CSS transition moves in
 * a straight ease — coins do not. This is a real particle system.
 *
 * What makes it read as a jackpot rather than as "some circles moving":
 *
 *   • VOLUME. 220 coins on a jackpot. You cannot count them, so it reads as
 *     an amount rather than as a number of objects.
 *   • GRAVITY + BOUNCE. Every coin is launched on a real ballistic arc, lands
 *     on a floor line, and bounces with energy loss and a little horizontal
 *     scatter. Coins settling in a pile is the single most "payout" thing a
 *     slot machine does.
 *   • SPIN WITH FORESHORTENING. Each coin spins on its own axis at its own
 *     rate; the sprite is drawn as an ellipse whose width is cos(spin), so it
 *     turns edge-on and back. That is what makes a flat disc look like a solid
 *     3D object instead of a sticker.
 *   • DEPTH. Coins carry a z in 0..1 — far coins are smaller, dimmer and
 *     slower, near coins are bigger, brighter and faster, and they are drawn
 *     back-to-front. The shower gains a front and a back.
 *   • GLINT. A moving specular highlight and a rim, so gold looks struck
 *     rather than filled.
 *
 * The canvas is sized to its container in device pixels, so it stays sharp on
 * retina without the CSS blur a fixed-size canvas would get.
 *
 * Honest scope: this draws coins. It does not know what a bounty is. The chest
 * owns the money.
 */

import React, { useEffect, useRef } from 'react';

export interface CoinShowerProps {
  /** Flip to true at the blast. Going false->true re-fires the burst. */
  active: boolean;
  /** Jackpots get roughly double the coins and a wider, higher launch. */
  isJackpot?: boolean;
  /** 0..1 across the container — where the coins erupt from (the chest mouth). */
  originX?: number;
  originY?: number;
  /** Scales every duration, matching the table-wide animation-speed setting. */
  speed?: number;
  /** Reduced-motion: draw a single settled frame instead of animating. */
  reduced?: boolean;
}

interface Coin {
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  r: number;
  spin: number;
  spinRate: number;
  tilt: number;
  bounces: number;
  settled: boolean;
  hue: number;
  life: number;
}

const GRAVITY = 1750; // px/s^2 at z=1 — tuned so a coin hangs ~0.9s
const FLOOR_FRAC = 0.94; // where coins land, as a fraction of canvas height
const RESTITUTION = 0.42; // energy kept per bounce
const MAX_BOUNCES = 3;

export const CoinShower: React.FC<CoinShowerProps> = ({
  active,
  isJackpot = false,
  originX = 0.5,
  originY = 0.46,
  speed = 1,
  reduced = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const coinsRef = useRef<Coin[]>([]);
  const lastRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;

    const parent = canvas.parentElement;
    const cssW = parent?.clientWidth || 600;
    const cssH = parent?.clientHeight || 420;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const ox = cssW * originX;
    const oy = cssH * originY;
    const floor = cssH * FLOOR_FRAC;

    // ── Launch ──────────────────────────────────────────────────────────────
    // Coins erupt in a cone biased upward: mostly up, fanning out. A uniform
    // 360-degree burst reads as an explosion; a fountain reads as a payout.
    const count = isJackpot ? 220 : 120;
    const coins: Coin[] = [];
    for (let i = 0; i < count; i++) {
      const spreadDeg = isJackpot ? 148 : 116;
      const angle = (-90 - spreadDeg / 2 + Math.random() * spreadDeg) * (Math.PI / 180);
      const power = (isJackpot ? 620 : 520) * (0.45 + Math.random() * 0.8);
      const z = Math.random();
      coins.push({
        x: ox + (Math.random() - 0.5) * 42,
        y: oy + (Math.random() - 0.5) * 16,
        vx: Math.cos(angle) * power,
        vy: Math.sin(angle) * power,
        z,
        r: (7 + Math.random() * 7) * (0.62 + z * 0.62),
        spin: Math.random() * Math.PI * 2,
        spinRate: (5 + Math.random() * 13) * (Math.random() < 0.5 ? -1 : 1),
        tilt: (Math.random() - 0.5) * 0.5,
        bounces: 0,
        settled: false,
        hue: Math.random(),
        life: 1,
      });
    }
    coinsRef.current = coins;

    const drawCoin = (c: Coin) => {
      // Depth: far coins recede in size and contrast.
      const depth = 0.55 + c.z * 0.45;
      // Foreshortening — this is the whole trick that makes a disc read as 3D.
      const face = Math.abs(Math.cos(c.spin));
      const w = Math.max(c.r * face, 0.9);
      const h = c.r;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, c.life)) * depth;
      ctx.translate(c.x, c.y);
      ctx.rotate(c.tilt);

      // Coin body: warm gold, lighter at the top-left like a struck face.
      const g = ctx.createLinearGradient(-w, -h, w, h);
      const warm = c.hue < 0.22;
      g.addColorStop(0, warm ? '#fff6cf' : '#ffe9a3');
      g.addColorStop(0.42, warm ? '#f7c948' : '#f0b429');
      g.addColorStop(1, warm ? '#b47e12' : '#8a5f0d');
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      // Rim — the darker edge that gives the disc thickness.
      ctx.lineWidth = Math.max(1, c.r * 0.16);
      ctx.strokeStyle = 'rgba(120, 78, 10, 0.85)';
      ctx.stroke();

      // Specular glint travelling across the face as it spins.
      if (face > 0.42) {
        ctx.beginPath();
        ctx.ellipse(-w * 0.26, -h * 0.3, w * 0.34, h * 0.24, -0.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.fill();
      }
      ctx.restore();
    };

    if (reduced) {
      // One settled frame: coins resting along the floor, no motion at all.
      for (const c of coins) {
        c.y = floor - Math.random() * 10;
        c.x = ox + (Math.random() - 0.5) * cssW * 0.8;
        c.spin = Math.random() * Math.PI * 2;
        drawCoin(c);
      }
      return;
    }

    lastRef.current = performance.now();
    const tick = (now: number) => {
      const dtRaw = (now - lastRef.current) / 1000;
      lastRef.current = now;
      // Clamp dt so a backgrounded tab does not teleport every coin off-screen
      // on the frame the tab wakes up.
      const dt = Math.min(dtRaw, 0.05) / Math.max(speed, 0.1);

      ctx.clearRect(0, 0, cssW, cssH);

      let alive = 0;
      // Back-to-front so near coins occlude far ones.
      const ordered = coinsRef.current.slice().sort((a, b) => a.z - b.z);
      for (const c of ordered) {
        if (!c.settled) {
          c.vy += GRAVITY * (0.72 + c.z * 0.5) * dt;
          c.x += c.vx * dt;
          c.y += c.vy * dt;
          c.spin += c.spinRate * dt;

          if (c.y >= floor) {
            c.y = floor;
            if (c.bounces >= MAX_BOUNCES || Math.abs(c.vy) < 60) {
              // Settle: lie flat and start fading with the pile.
              c.settled = true;
              c.vy = 0;
              c.vx = 0;
              c.spin = Math.PI / 2;
            } else {
              c.bounces++;
              c.vy = -c.vy * RESTITUTION;
              c.vx = c.vx * 0.62 + (Math.random() - 0.5) * 40;
              c.spinRate *= 0.6;
            }
          }
        }

        // Settled coins linger a beat, then fade so the felt is not left
        // covered in gold for the rest of the hand.
        if (c.settled) c.life -= dt * 0.55;
        else if (c.x < -60 || c.x > cssW + 60) c.life -= dt * 2;

        if (c.life > 0) {
          alive++;
          drawCoin(c);
        }
      }

      if (alive > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      coinsRef.current = [];
    };
  }, [active, isJackpot, originX, originY, speed, reduced]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="mbc__coin-canvas" aria-hidden="true" />;
};

export default CoinShower;
