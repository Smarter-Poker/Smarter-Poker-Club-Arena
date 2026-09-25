/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ACHIEVEMENT SHARE CARD - Q3 Wave 2 (Block D)
 * Generate shareable social media cards for unlocked achievements
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * #ClubArenaConsole (2026-09-14): the dialog is a SpadeConsole - the
 * achievement printed on the black glass between the rails, its rarity in the
 * head's painted pill slot, Close on the steel plate and Share on the blue
 * glass. Nothing is drawn in CSS. The PNG the player actually shares is still
 * painted on the canvas below, in the same inks the console prints in
 * (silver, blue, white, gold - no browns, no pinks, no purples).
 */

import React, { useRef, useCallback, useState } from 'react';
import { haptic } from '../../services/HapticService';
import './AchievementShareCard.css';
import { reportError } from '../../utils/errorReporter';
import { isNativePlatform } from '../../lib/appBase';
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
import { titleCase } from '../../utils/titleCase';

interface AchievementShareCardProps {
  icon: string;
  name: string;
  description: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  unlockedAt?: string;
  onClose: () => void;
}

/* The rarity inks are the console's own (SpadeConsole.css sc-ink--*): muted
   silver, lit blue, the white with the blue glow, and brand gold. The glow is
   the ink's own halo, used by the canvas for the ring behind the emblem. */
const RARITY_COLORS: Record<
  string,
  { ink: string; glow: string; label: string; pill: ConsoleInk }
> = {
  common: { ink: '#9aa5b3', glow: 'rgba(154, 165, 179, 0.28)', label: 'Common', pill: 'muted' },
  rare: { ink: '#45adff', glow: 'rgba(49, 168, 255, 0.4)', label: 'Rare', pill: 'blue' },
  epic: { ink: '#f4f7fb', glow: 'rgba(140, 210, 255, 0.45)', label: 'Epic', pill: 'white' },
  legendary: { ink: '#ffd700', glow: 'rgba(255, 215, 0, 0.4)', label: 'Legendary', pill: 'gold' },
};

export const AchievementShareCard: React.FC<AchievementShareCardProps> = ({
  icon,
  name,
  description,
  rarity,
  unlockedAt,
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sharing, setSharing] = useState(false);
  const colors = RARITY_COLORS[rarity] || RARITY_COLORS.common;

  const generateCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    canvas.width = 600;
    canvas.height = 400;

    // Black glass, the console's own ground.
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, 600, 400);

    // Inner rarity glow circle behind icon
    const glowGrad = ctx.createRadialGradient(300, 130, 20, 300, 130, 120);
    glowGrad.addColorStop(0, colors.glow);
    glowGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(180, 10, 240, 240);

    // Border frame with glow
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 2;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 20;
    ctx.strokeRect(12, 12, 576, 376);
    ctx.shadowBlur = 0;

    // Top-left branding
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SMARTER.POKER', 28, 36);

    // Top-right rarity badge
    ctx.fillStyle = colors.ink;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(colors.label.toUpperCase(), 572, 36);

    // Icon (large emoji)
    ctx.font = '72px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(icon, 300, 150);

    // Achievement name
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText(titleCase(name), 300, 220);

    // Description
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(titleCase(description), 300, 260);

    // Unlocked date
    if (unlockedAt) {
      const date = new Date(unlockedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(`Unlocked ${date}`, 300, 305);
    }

    // Bottom divider line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(60, 340);
    ctx.lineTo(540, 340);
    ctx.stroke();

    // Bottom branding
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('CLUB ARENA - smarter.poker', 300, 370);

    return canvas;
  }, [icon, name, description, rarity, unlockedAt, colors]);

  const handleShare = async () => {
    haptic.success();
    setSharing(true);

    const canvas = generateCanvas();
    if (!canvas) {
      setSharing(false);
      return;
    }

    try {
      // Try Web Share API first (mobile)
      if (navigator.share && navigator.canShare) {
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, 'image/png');
        });

        if (blob) {
          const file = new File(
            [blob],
            `achievement-${name.toLowerCase().replace(/\s+/g, '-')}.png`,
            {
              type: 'image/png',
            }
          );

          const shareData = {
            title: `${name}`,
            text: `I just unlocked "${name}" on Club Arena! ${description}`,
            files: [file],
          };

          if (navigator.canShare(shareData)) {
            await navigator.share(shareData);
            setSharing(false);
            onClose();
            return;
          }
        }
      }

      // THE APP (2026-09-08): Android's webview has no navigator.share and
      // neither webview honours <a download>. The system share sheet, via
      // Filesystem + Share (src/lib/native/share.ts).
      if (isNativePlatform()) {
        const png = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png')
        );
        if (png) {
          const { nativeShareBlob } = await import('../../lib/native/share');
          await nativeShareBlob(
            png,
            `achievement-${name.toLowerCase().replace(/\s+/g, '-')}.png`,
            name
          );
          return;
        }
      }

      // Fallback: download the image
      const link = document.createElement('a');
      link.download = `achievement-${name.toLowerCase().replace(/\s+/g, '-')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        reportError(err, 'AchievementShareCard.Share_failed');
      }
    }

    setSharing(false);
  };

  const unlockedLabel = unlockedAt
    ? new Date(unlockedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  return (
    <div className="share-card-overlay" onClick={onClose}>
      <div
        className="share-card-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-card-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          onClose={onClose}
          eyebrow="Club Arena"
          title="Share Achievement"
          titleId="share-card-title"
          pill={colors.label}
          pillInk={colors.pill}
          plates={{
            secondary: { label: 'Close', onClick: onClose },
            primary: {
              label: sharing ? 'Sharing...' : 'Share',
              ink: 'white',
              onClick: handleShare,
              disabled: sharing,
            },
          }}
        >
          {/* Preview: the achievement printed on the glass */}
          <div className={`share-card-preview share-rarity-${rarity}`}>
            <span className="share-card-icon" aria-hidden="true">
              {icon}
            </span>
            <h3 className="share-card-name sc-ink--silver">{titleCase(name)}</h3>
            <p className="share-card-desc sc-copy sc-copy--center">{titleCase(description)}</p>
            <div className="share-card-rows">
              <div className="share-card-row">
                <span className="share-card-row__label sc-label sc-ink--blue">Rarity</span>
                <span className={`share-card-row__value sc-ink--${colors.pill}`}>
                  {colors.label}
                </span>
              </div>
              {unlockedLabel && (
                <div className="share-card-row">
                  <span className="share-card-row__label sc-label sc-ink--blue">Unlocked</span>
                  <span className="share-card-row__value sc-ink--silver">{unlockedLabel}</span>
                </div>
              )}
            </div>
          </div>

          {/* Hidden canvas for image generation */}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </SpadeConsole>
      </div>
    </div>
  );
};

export default AchievementShareCard;
