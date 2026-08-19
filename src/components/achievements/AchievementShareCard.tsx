/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ ACHIEVEMENT SHARE CARD — Q3 Wave 2 (Block D)
 * Generate shareable social media cards for unlocked achievements
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useRef, useCallback, useState } from 'react';
import { haptic } from '../../services/HapticService';
import './AchievementShareCard.css';
import { reportError } from '../../utils/errorReporter';

interface AchievementShareCardProps {
  icon: string;
  name: string;
  description: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  unlockedAt?: string;
  onClose: () => void;
}

const RARITY_COLORS: Record<string, { bg: string; border: string; glow: string; label: string }> = {
  common: { bg: '#1a1a2e', border: '#4a4a6a', glow: 'rgba(150, 150, 200, 0.3)', label: 'Common' },
  rare: { bg: '#0a1628', border: '#2196f3', glow: 'rgba(33, 150, 243, 0.4)', label: 'Rare' },
  epic: { bg: '#1a0a28', border: '#9c27b0', glow: 'rgba(156, 39, 176, 0.4)', label: 'Epic' },
  legendary: {
    bg: '#1a1400',
    border: '#ff9800',
    glow: 'rgba(255, 152, 0, 0.4)',
    label: 'Legendary',
  },
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

    // Premium gradient background
    const gradient = ctx.createLinearGradient(0, 0, 600, 400);
    gradient.addColorStop(0, '#050a18');
    gradient.addColorStop(0.4, colors.bg);
    gradient.addColorStop(1, '#050a18');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 600, 400);

    // Inner rarity glow circle behind icon
    const glowGrad = ctx.createRadialGradient(300, 130, 20, 300, 130, 120);
    glowGrad.addColorStop(0, colors.glow);
    glowGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(180, 10, 240, 240);

    // Border frame with glow
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 2;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 20;
    ctx.strokeRect(12, 12, 576, 376);
    ctx.shadowBlur = 0;

    // Top-left branding
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('♠  SMARTER.POKER', 28, 36);

    // Top-right rarity badge
    ctx.fillStyle = colors.border;
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
    ctx.fillText(name, 300, 220);

    // Description
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(description, 300, 260);

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
    ctx.fillText('CLUB ARENA · smarter.poker', 300, 370);

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

  return (
    <div className="share-card-overlay" onClick={onClose}>
      <div className="share-card-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-card-header">
          <span>Share Achievement</span>
          <button className="share-card-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Preview */}
        <div
          className={`share-card-preview share-rarity-${rarity}`}
          style={{ borderColor: colors.border }}
        >
          <span className="share-card-icon">{icon}</span>
          <h3 className="share-card-name">{name}</h3>
          <p className="share-card-desc">{description}</p>
          <span className="share-card-rarity" style={{ color: colors.border }}>
            {colors.label}
          </span>
        </div>

        {/* Hidden canvas for image generation */}
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {/* Share Button */}
        <button className="share-card-btn" onClick={handleShare} disabled={sharing}>
          {sharing ? 'Sharing...' : 'Share'}
        </button>
      </div>
    </div>
  );
};

export default AchievementShareCard;
