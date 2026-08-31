/**
 * StatsShareCard — a downloadable/shareable PNG of a player's headline stats.
 *
 * WHY CANVAS AND NOT A PDF LIBRARY
 * --------------------------------
 * This adds ZERO dependencies and zero bundle weight. AchievementShareCard
 * already proves the pattern works in this app (600x400 canvas, navigator.share
 * with a download fallback), so this is the same technique at social-card
 * dimensions.
 *
 * It is also the export people will actually use. A PDF dossier is something
 * you read once; a card is something you post in the club chat after a good
 * session, which is the behaviour worth building for.
 *
 * NOTE ON FONTS: canvas has no webfont guarantee at draw time, so this uses a
 * system stack. Trying to draw in Inter would risk a silent fallback mid-render
 * and inconsistent metrics between machines.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import './StatsShareCard.css';

interface Props {
  displayName: string;
  stats: {
    hands: number;
    bb100: number;
    profit: number;
    vpip: number; // percent
    pfr: number; // percent
    hoursPlayed: number;
  };
  styleLabel?: string | null;
  styleColor?: string | null;
}

const W = 1200;
const H = 630;

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

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
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default function StatsShareCard({ displayName, stats, styleLabel, styleColor }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = W;
    canvas.height = H;

    // Background
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0a0a14');
    bg.addColorStop(0.5, '#0d1520');
    bg.addColorStop(1, '#0a0a14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Accent glow
    const glow = ctx.createRadialGradient(W * 0.22, H * 0.3, 0, W * 0.22, H * 0.3, W * 0.6);
    glow.addColorStop(0, 'rgba(0,212,255,0.14)');
    glow.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Border
    ctx.strokeStyle = 'rgba(0,212,255,0.28)';
    ctx.lineWidth = 3;
    roundRect(ctx, 14, 14, W - 28, H - 28, 26);
    ctx.stroke();

    // Name
    ctx.fillStyle = '#e8f4ff';
    ctx.font = `700 54px ${FONT}`;
    ctx.textBaseline = 'top';
    // Measured, not counted: 23 wide glyphs at 54px can still reach the
    // right-aligned "smarter.poker" footer, which sits in the same band.
    const NAME_MAX_W = W - 64 - 260;
    let name = displayName;
    while (name.length > 1 && ctx.measureText(`${name}...`).width > NAME_MAX_W) {
      name = name.slice(0, -1);
    }
    if (name !== displayName) name = `${name}...`;
    ctx.fillText(name, 64, 62);

    // Style badge
    if (styleLabel) {
      const label = styleLabel.toUpperCase();
      ctx.font = `700 22px ${FONT}`;
      const tw = ctx.measureText(label).width;
      const bx = 64;
      const by = 132;
      ctx.fillStyle = `${styleColor ?? '#00d4ff'}22`;
      roundRect(ctx, bx, by, tw + 34, 42, 21);
      ctx.fill();
      ctx.strokeStyle = styleColor ?? '#00d4ff';
      ctx.lineWidth = 1.5;
      roundRect(ctx, bx, by, tw + 34, 42, 21);
      ctx.stroke();
      ctx.fillStyle = styleColor ?? '#00d4ff';
      ctx.fillText(label, bx + 17, by + 10);
    }

    // Headline stat: win rate
    const bbColor = stats.bb100 >= 0 ? '#22c55e' : '#ef4444';
    ctx.fillStyle = 'rgba(200,224,245,0.55)';
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText('WIN RATE', 64, 232);
    ctx.fillStyle = bbColor;
    ctx.font = `800 96px ${FONT}`;
    const bbText = `${stats.bb100 >= 0 ? '+' : ''}${stats.bb100.toFixed(1)}`;
    ctx.fillText(bbText, 64, 262);
    const bbW = ctx.measureText(bbText).width;
    ctx.fillStyle = 'rgba(200,224,245,0.6)';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText('bb/100', 64 + bbW + 16, 322);

    // Profit, beside the win rate. This is the number people screenshot.
    const profitColor = stats.profit >= 0 ? '#22c55e' : '#ef4444';
    ctx.fillStyle = 'rgba(200,224,245,0.55)';
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText('PROFIT', 470, 232);
    ctx.fillStyle = profitColor;
    ctx.font = `800 64px ${FONT}`;
    ctx.fillText(
      `${stats.profit >= 0 ? '+' : '-'}${Math.round(Math.abs(stats.profit)).toLocaleString()}`,
      470,
      278
    );

    // Stat tiles
    const tiles: Array<[string, string]> = [
      ['HANDS', stats.hands.toLocaleString()],
      ['HOURS', stats.hoursPlayed.toFixed(1)],
      ['VPIP', `${stats.vpip.toFixed(1)}%`],
      ['PFR', `${stats.pfr.toFixed(1)}%`],
    ];
    const tileW = 244;
    const tileH = 118;
    const startX = 64;
    const startY = 412;
    tiles.forEach(([label, value], i) => {
      const x = startX + i * (tileW + 16);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      roundRect(ctx, x, startY, tileW, tileH, 16);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      roundRect(ctx, x, startY, tileW, tileH, 16);
      ctx.stroke();

      ctx.fillStyle = 'rgba(200,224,245,0.5)';
      ctx.font = `600 18px ${FONT}`;
      ctx.fillText(label, x + 20, startY + 20);
      ctx.fillStyle = '#e8f4ff';
      ctx.font = `800 40px ${FONT}`;
      ctx.fillText(value, x + 20, startY + 50);
    });

    // Footer
    ctx.fillStyle = 'rgba(0,212,255,0.75)';
    ctx.font = `700 26px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('smarter.poker', W - 64, 74);
    ctx.textAlign = 'left';
  }, [displayName, stats, styleLabel, styleColor]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleShare = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    setNote(null);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        setNote('Could not build the image. Try again.');
        return;
      }
      const file = new File([blob], 'smarter-poker-stats.png', { type: 'image/png' });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My Smarter Poker stats' });
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'smarter-poker-stats.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Revoke on the next frame: revoking synchronously can cancel the
      // download in some browsers before it has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNote('Saved to your downloads.');
    } catch (err) {
      // AbortError just means the user dismissed the share sheet.
      if ((err as Error)?.name !== 'AbortError') {
        setNote('Could not share the image on this device.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sharecard">
      <h3 className="sharecard-title">Share Your Stats</h3>
      <div className="sharecard-preview">
        <canvas
          ref={canvasRef}
          className="sharecard-canvas"
          role="img"
          aria-label="A Shareable Image Of Your Headline Poker Stats"
        />
      </div>
      <button type="button" className="sharecard-btn" onClick={handleShare} disabled={busy}>
        {busy ? 'Preparing...' : 'Share Or Save Image'}
      </button>
      <p className="sharecard-note" role="status" aria-live="polite">
        {note}
      </p>
    </div>
  );
}
