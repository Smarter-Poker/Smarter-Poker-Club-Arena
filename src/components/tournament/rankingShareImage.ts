/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RESULT CARD, AS A PICTURE A PLAYER CAN SHARE (2026-10-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Share used to send a sentence and a link. A finishing place is the thing a
 * player shows off, and a sentence is the least of it, so Share now hands the
 * system sheet an image of the result alongside that sentence.
 *
 * THE IMAGE IS PAINTED FROM THE SAME MASTER AS THE CARD. The head is the VIP
 * console's own top-vip-v2.png, the body is mid.png repeated, the foot is the flat
 * cap - the approved art at its native 1000px width, never redrawn - and every
 * line is printed in the inks the console prints in (SpadeConsole.css). Only
 * the medal is drawn, exactly as it is on the card, with the card's own trophy
 * paths. So the picture that leaves the app is the card, not a second design.
 *
 * Painting happens AHEAD of the tap (TournamentRankingCard pre-paints when it
 * opens): iOS Safari refuses navigator.share once the tap's activation has
 * been spent awaiting image loads, so the image must already exist when the
 * player presses Share. Everything here fails soft - no canvas, a blocked
 * image, a missing font - by returning null, and Share falls back to the text.
 */

import { arenaDisplayText } from '../../lib/arenaDisplay/text';
import { APP_BASE_URL } from '../../lib/appBase';
import { TROPHY_PATHS, type ShareTier } from './rankingTrophy';

export type { ShareTier };

export interface RankingShareInput {
  /** "04-Oct · 128 Entrants" - the eyebrow, exactly as the card prints it. */
  eyebrow: string;
  /** "Ranking" or "Qualified". */
  title: string;
  /** The event name, the card's subtitle. */
  subtitle: string;
  /** "#3", or null for a qualification. */
  pill: string | null;
  /** "Champion", "Runner Up", "Third Place", "Finished", "Satellite". */
  placeTitle: string;
  /** The numeral and suffix ("47", "th"), or a single word ("Qualified"). */
  place: { num: string; suffix: string } | { word: string };
  /** The place inside the medal: a trophy for the podium, else the numeral. */
  medal: { trophy: true } | { trophy: false; text: string };
  tier: ShareTier;
  payoutLabel: string;
  /** Already formatted at the event's unit, suffix included. */
  payoutValue: string;
  username: string | null;
}

/* The master's own measurements (SpadeConsole.tsx). Native pixels. */
const W = 1000;
const TOP_H = 348;
const FOOT_H = 72;
const BODY_H = 1000;
const H = TOP_H + BODY_H + FOOT_H;

/* The console's inks (SpadeConsole.css, sc-ink--*). */
const SILVER = '#e4e7ec';
const BLUE = '#45adff';
const MUTED = '#9aa5b3';
const CYAN = '#00d4ff';

/* The medal ramp, the card's own (TournamentRankingCard.css). */
const TIERS: Record<
  ShareTier,
  { face: [string, string, string]; edge: string; ink: string; glow: string; band: string }
> = {
  gold: {
    face: ['#ffffff', '#b9e8ff', '#4aa8d8'],
    edge: '#9fe4ff',
    ink: '#0b2233',
    glow: 'rgba(0, 212, 255, 0.45)',
    band: '#1877f2',
  },
  silver: {
    face: ['#f4f7fb', '#c6cfda', '#8e9aa9'],
    edge: '#e3e9f1',
    ink: '#2c3542',
    glow: 'rgba(214, 226, 240, 0.36)',
    band: '#5b6878',
  },
  bronze: {
    face: ['#cfe0f2', '#7d95b4', '#4a5f7d'],
    edge: '#b6cbe4',
    ink: '#16202e',
    glow: 'rgba(150, 180, 220, 0.32)',
    band: '#3c5170',
  },
  steel: {
    face: ['#9fb2ca', '#6d829e', '#47576e'],
    edge: '#a9bcd4',
    ink: '#101825',
    glow: 'rgba(140, 170, 210, 0.3)',
    band: '#33435a',
  },
};

const CHROME = '"Roboto Condensed", Inter, system-ui, sans-serif';
const ART = `${APP_BASE_URL}assets/club-buttons/console/spade-console-v1/`;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`share art failed to load: ${src}`));
    img.src = src;
  });
}

type Ctx = CanvasRenderingContext2D & { letterSpacing?: string };

/** A line at `px`, shrunk until it fits `maxW`. Returns the size used. */
function fitFont(ctx: Ctx, text: string, weight: number, px: number, maxW: number, min = 0.5) {
  let size = px;
  for (;;) {
    ctx.font = `${weight} ${size}px ${CHROME}`;
    if (ctx.measureText(text).width <= maxW || size <= px * min) return size;
    size = Math.floor(size * 0.94);
  }
}

/** The console's engraved silver: a solid ink and a bevel, never a gradient fill. */
function engraved(ctx: Ctx, text: string, x: number, y: number, unit: number) {
  ctx.fillStyle = '#050607';
  ctx.fillText(text, x, y + unit * 0.45);
  ctx.fillStyle = '#6d747c';
  ctx.fillText(text, x, y + unit * 0.25);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.fillText(text, x, y - unit * 0.18);
  ctx.fillStyle = SILVER;
  ctx.fillText(text, x, y);
}

/** Lit blue caps, the console's eyebrow and label ink. */
function lit(ctx: Ctx, text: string, x: number, y: number, color = BLUE) {
  ctx.save();
  ctx.shadowColor = 'rgba(49, 168, 255, 0.7)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function withSpacing(ctx: Ctx, em: number, size: number) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(em * size)}px`;
}

function paintMedal(ctx: Ctx, input: RankingShareInput, cx: number, cy: number) {
  const t = TIERS[input.tier];
  const r = 118;

  // The starburst, in the medal's own light, fading before the rails.
  ctx.save();
  ctx.translate(cx, cy);
  const rayR = 300;
  const fade = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, rayR);
  fade.addColorStop(0, t.glow);
  fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = fade;
  ctx.globalAlpha = input.tier === 'steel' ? 0.45 : 1;
  const beams = 24;
  for (let i = 0; i < beams; i++) {
    const a = (i / beams) * Math.PI * 2;
    const half = (4 / 360) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, rayR, a - half, a + half);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // The disc: the face ramp, the edge, the struck inner rim.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  const face = ctx.createLinearGradient(cx - r * 0.34, cy - r, cx + r * 0.34, cy + r);
  face.addColorStop(0, t.face[0]);
  face.addColorStop(0.45, t.face[1]);
  face.addColorStop(1, t.face[2]);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 12;
  ctx.strokeStyle = t.edge;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, r - 21, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.beginPath();
  ctx.arc(cx, cy, r - 23.5, 0, Math.PI * 2);
  ctx.stroke();

  // What the disc carries.
  if (input.medal.trophy) {
    const s = 110 / 48;
    ctx.save();
    ctx.translate(cx - 24 * s, cy - 24 * s);
    ctx.scale(s, s);
    ctx.fillStyle = t.ink;
    ctx.strokeStyle = t.ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    ctx.stroke(new Path2D(TROPHY_PATHS.handleLeft));
    ctx.stroke(new Path2D(TROPHY_PATHS.handleRight));
    ctx.lineWidth = 2;
    const cup = new Path2D(TROPHY_PATHS.cup);
    ctx.fill(cup);
    ctx.stroke(cup);
    ctx.lineWidth = 2.4;
    const base = new Path2D(TROPHY_PATHS.base);
    ctx.fill(base);
    ctx.stroke(base);
    ctx.restore();
  } else {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, input.medal.text, 900, 104, r * 1.4);
    ctx.fillStyle = t.ink;
    ctx.fillText(input.medal.text, cx, cy + 4);
  }
}

/**
 * Paint the share image. Null whenever the platform cannot paint it - the
 * caller shares the text instead, so a player never gets an error for this.
 */
export async function paintRankingShareImage(input: RankingShareInput): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  // Canvas text bypasses JSX; normalize a local display copy before measuring or painting.
  input = {
    ...input,
    eyebrow: arenaDisplayText(input.eyebrow),
    title: arenaDisplayText(input.title),
    subtitle: arenaDisplayText(input.subtitle),
    pill: input.pill === null ? null : arenaDisplayText(input.pill),
    placeTitle: arenaDisplayText(input.placeTitle),
    place:
      'word' in input.place
        ? { word: arenaDisplayText(input.place.word) }
        : { num: arenaDisplayText(input.place.num), suffix: arenaDisplayText(input.place.suffix) },
    medal: input.medal.trophy
      ? input.medal
      : { trophy: false, text: arenaDisplayText(input.medal.text) },
    payoutLabel: arenaDisplayText(input.payoutLabel),
    payoutValue: arenaDisplayText(input.payoutValue),
    username: input.username === null ? null : arenaDisplayText(input.username),
  };
  let canvas: HTMLCanvasElement;
  let ctx: Ctx | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext('2d') as Ctx | null;
  } catch {
    return null;
  }
  if (!ctx || typeof canvas.toBlob !== 'function') return null;

  let top: HTMLImageElement, mid: HTMLImageElement, foot: HTMLImageElement;
  try {
    [top, mid, foot] = await Promise.all([
      loadImage(`${ART}top-vip-v2.png`),
      loadImage(`${ART}mid.png`),
      loadImage(`${ART}bottom-foot.png`),
    ]);
    if (document.fonts?.load) {
      await Promise.all([
        document.fonts.load(`900 100px ${CHROME}`),
        document.fonts.load(`800 40px ${CHROME}`),
      ]);
    }
  } catch {
    return null;
  }

  const t = TIERS[input.tier];

  // The ground behind the art, the console's own black glass.
  ctx.fillStyle = '#050607';
  ctx.fillRect(0, 0, W, H);

  // ── The frame: the master, at its native width ──
  const midH = Math.round((mid.naturalHeight * W) / mid.naturalWidth) || 12;
  for (let y = TOP_H; y < TOP_H + BODY_H; y += midH) ctx.drawImage(mid, 0, y, W, midH);
  ctx.drawImage(top, 0, 0, W, TOP_H);
  ctx.drawImage(foot, 0, TOP_H + BODY_H, W, FOOT_H);

  // ── The head, printed into the master's measured zones ──
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  withSpacing(ctx, 0.14, 24);
  fitFont(ctx, input.eyebrow.toUpperCase(), 800, 24, 320);
  lit(ctx, input.eyebrow.toUpperCase(), 100, 156);
  withSpacing(ctx, 0, 1);
  const tSize = fitFont(ctx, input.title.toUpperCase(), 900, 76, input.pill ? 470 : 540);
  engraved(ctx, input.title.toUpperCase(), 100, 236, tSize / 30);
  withSpacing(ctx, 0.06, 28);
  fitFont(ctx, input.subtitle.toUpperCase(), 700, 30, 540);
  ctx.fillStyle = MUTED;
  ctx.fillText(input.subtitle.toUpperCase(), 102, 294);
  withSpacing(ctx, 0, 1);
  if (input.pill) {
    ctx.textAlign = 'center';
    const pSize = fitFont(ctx, input.pill, 900, 36, 170);
    engraved(ctx, input.pill, 673 + 197 / 2, 230, pSize / 30);
  }

  // ── The body, top to bottom as the card reads ──
  ctx.textAlign = 'center';
  let y = TOP_H + 58;
  withSpacing(ctx, 0.06, 34);
  ctx.font = `900 34px ${CHROME}`;
  const brandA = 'SMARTER';
  const brandB = 'POKER';
  const wa = ctx.measureText(brandA).width;
  const wb = ctx.measureText(brandB).width;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#eaf1ff';
  ctx.fillText(brandA, W / 2 - (wa + wb) / 2, y);
  ctx.fillStyle = CYAN;
  ctx.fillText(brandB, W / 2 - (wa + wb) / 2 + wa, y);
  ctx.textAlign = 'center';
  withSpacing(ctx, 0, 1);

  paintMedal(ctx, input, W / 2, TOP_H + 252);

  // The light the place stands in, painted first so the words sit on it.
  const placeY = TOP_H + 642;
  ctx.save();
  ctx.translate(W / 2, placeY - 70);
  ctx.scale(1, 0.5);
  const band = ctx.createRadialGradient(0, 0, 0, 0, 0, 380);
  band.addColorStop(0, `${t.band}b0`);
  band.addColorStop(1, `${t.band}00`);
  ctx.fillStyle = band;
  ctx.beginPath();
  ctx.arc(0, 0, 380, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const hair = ctx.createLinearGradient(220, 0, W - 220, 0);
  hair.addColorStop(0, `${t.band}00`);
  hair.addColorStop(0.5, t.band);
  hair.addColorStop(1, `${t.band}00`);
  ctx.fillStyle = hair;
  ctx.fillRect(220, placeY + 34, W - 440, 2);

  // The finish, named between engraved rules.
  const labelY = TOP_H + 446;
  withSpacing(ctx, 0.32, 30);
  ctx.font = `800 30px ${CHROME}`;
  const label = input.placeTitle.toUpperCase();
  const lw = ctx.measureText(label).width;
  lit(ctx, label, W / 2, labelY);
  ctx.fillStyle = '#000';
  ctx.fillRect(W / 2 - lw / 2 - 130, labelY - 11, 100, 2);
  ctx.fillRect(W / 2 + lw / 2 + 30, labelY - 11, 100, 2);
  withSpacing(ctx, 0, 1);

  // The place.
  if ('word' in input.place) {
    fitFont(ctx, input.place.word.toUpperCase(), 900, 120, 700);
    engraved(ctx, input.place.word.toUpperCase(), W / 2, placeY - 20, 4);
  } else {
    ctx.font = `900 190px ${CHROME}`;
    const nw = ctx.measureText(input.place.num).width;
    ctx.font = `900 70px ${CHROME}`;
    const sw = ctx.measureText(input.place.suffix.toUpperCase()).width;
    const x0 = W / 2 - (nw + 8 + sw) / 2;
    ctx.textAlign = 'left';
    ctx.font = `900 190px ${CHROME}`;
    engraved(ctx, input.place.num, x0, placeY, 6);
    ctx.font = `900 70px ${CHROME}`;
    engraved(ctx, input.place.suffix.toUpperCase(), x0 + nw + 8, placeY - 82, 3);
    ctx.textAlign = 'center';
  }

  y = placeY;
  // What it paid.
  y += 110;
  withSpacing(ctx, 0.2, 24);
  ctx.font = `700 24px ${CHROME}`;
  lit(ctx, input.payoutLabel.toUpperCase(), W / 2, y, CYAN);
  withSpacing(ctx, 0, 1);
  y += 92;
  const vSize = fitFont(ctx, input.payoutValue, 900, 84, 700);
  engraved(ctx, input.payoutValue, W / 2, y, vSize / 30);

  // Who, and where to find the room.
  if (input.username) {
    y += 78;
    fitFont(ctx, input.username, 800, 34, 640);
    ctx.fillStyle = SILVER;
    ctx.fillText(input.username, W / 2, y);
  }
  withSpacing(ctx, 0.16, 20);
  ctx.font = `700 20px ${CHROME}`;
  ctx.fillStyle = MUTED;
  ctx.fillText('SMARTER.POKER/HUB/CLUB-ARENA', W / 2, TOP_H + BODY_H - 40);

  return new Promise((resolve) => {
    try {
      // The ground is opaque: quality 0.9 preserves the chrome and text while
      // avoiding a near-megabyte lossless payload in mobile share targets.
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9);
    } catch {
      resolve(null);
    }
  });
}
