/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ClubCardGenerator — Template-Based Club/Union Card Compositing
 * ═══════════════════════════════════════════════════════════════════════════════
 * Generates club/union cards by:
 * 1. Drawing a dark metallic background with CSS-like gradients
 * 2. Drawing the ID plate zone at top
 * 3. Fitting the club's logo (a curated preset crest or the owner's uploaded
 *    image) into the center viewport
 * 4. Drawing the name plate zone
 * 5. Drawing the stats bar with stat labels (MEMBERS, LEVEL, ACTIVE)
 * Returns as data URL
 *
 * Uses 3:4 aspect ratio to match the new ClubCardPanel layout.
 */

import { reportError } from '../utils/errorReporter';
interface CardGeneratorOptions {
  logoUrl: string;
  clubId: number;
  clubName: string;
  entityType?: 'club' | 'union';
}

// Card dimensions — 3:4 aspect ratio
/**
 * Dan 2026-08-20: this used to bake a WHOLE card — id plate, logo, name plate
 * and a stats bar — 600x800. Its only consumer, ClubCardPanel, renders those
 * as four live DOM zones and puts this image in ZONE 2 alone: a 1/1 viewport
 * with object-fit: cover. So the two components had opposite ideas of what
 * this file produces, and nobody ever saw it, because the upload was blocked
 * by an RLS policy from the day it was written (see
 * 20260820_club_assets_allow_club_cards_insert.sql). The moment the policy was
 * fixed and cards started appearing, every club card showed its name and its
 * MEMBERS/LEVEL/ACTIVE strip twice — once baked into the image, once live
 * underneath — with the 3:4 image cropped to its middle band by `cover`.
 *
 * The live DOM zones win: they update. This now produces ONLY the viewport
 * art, square, so `cover` fits it exactly.
 */
const CARD_WIDTH = 600;
const CARD_HEIGHT = 600;

// Zone heights (proportional to design)
// Viewport art only — the plates and stats bar are live DOM in ClubCardPanel.
const ID_PLATE_HEIGHT = 0;
const STATS_BAR_HEIGHT = 0;
const NAME_PLATE_HEIGHT = 0;
const VIEWPORT_TOP = ID_PLATE_HEIGHT;
const VIEWPORT_HEIGHT = CARD_HEIGHT - ID_PLATE_HEIGHT - NAME_PLATE_HEIGHT - STATS_BAR_HEIGHT; // ~52%

// Viewport — no insets, images fill edge-to-edge
const VIEWPORT_INSET = 0;
const VIEWPORT_X = VIEWPORT_INSET;
const VIEWPORT_Y = VIEWPORT_TOP;
const VIEWPORT_W = CARD_WIDTH;
const VIEWPORT_H = VIEWPORT_HEIGHT;

export interface CardGeneratorResult {
  dataUrl: string;
  format: 'webp' | 'png';
}

export class ClubCardGenerator {
  /**
   * Generate a complete club/union card with logo, ID, and name
   */
  static async generateCard(options: CardGeneratorOptions): Promise<CardGeneratorResult> {
    // clubId and clubName stay in the options type — callers pass them and the
    // panel still renders both — but nothing is drawn from them here any more.
    const { logoUrl, entityType = 'club' } = options;
    const isUnion = entityType === 'union';

    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ctx = canvas.getContext('2d')!;

    // Draw card background
    this.drawBackground(ctx, isUnion);

    // Viewport background, then the club's logo cover-filled over it. Nothing
    // else: the id plate, name plate and stats bar are live DOM zones around
    // this image, and baking copies of them here is what produced doubled
    // names and an empty second stats strip on every card.
    this.drawViewportBg(ctx);
    await this.drawLogo(ctx, logoUrl);

    // Prefer WebP
    const webpTest = canvas.toDataURL('image/webp');
    if (webpTest.startsWith('data:image/webp')) {
      return { dataUrl: webpTest, format: 'webp' };
    }
    return { dataUrl: canvas.toDataURL('image/png'), format: 'png' };
  }

  /**
   * Draw the card background with metallic gradient
   */
  private static drawBackground(ctx: CanvasRenderingContext2D, isUnion: boolean) {
    const gradient = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
    gradient.addColorStop(0, '#12192e');
    gradient.addColorStop(0.4, '#0a1120');
    gradient.addColorStop(1, '#0d1528');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    // Subtle border
    ctx.strokeStyle = isUnion ? 'rgba(218, 165, 32, 0.35)' : 'rgba(100, 130, 180, 0.25)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, CARD_WIDTH - 3, CARD_HEIGHT - 3);
  }

  /**
   * Zone 2: Viewport background (recessed dark area)
   */
  private static drawViewportBg(ctx: CanvasRenderingContext2D) {
    const gradient = ctx.createLinearGradient(0, VIEWPORT_Y, 0, VIEWPORT_Y + VIEWPORT_H);
    gradient.addColorStop(0, 'rgba(5, 10, 22, 0.95)');
    gradient.addColorStop(1, 'rgba(8, 16, 32, 0.98)');
    ctx.fillStyle = gradient;
    ctx.fillRect(VIEWPORT_X, VIEWPORT_Y, VIEWPORT_W, VIEWPORT_H);

    // Inner border
    ctx.strokeStyle = 'rgba(60, 80, 120, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(VIEWPORT_X, VIEWPORT_Y, VIEWPORT_W, VIEWPORT_H);
  }

  /**
   * Draw logo/image in the viewport
   */
  private static async drawLogo(ctx: CanvasRenderingContext2D, logoUrl: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        // Cover-fill the viewport area
        const scale = Math.max(VIEWPORT_W / img.width, VIEWPORT_H / img.height);
        const scaledWidth = img.width * scale;
        const scaledHeight = img.height * scale;
        const x = VIEWPORT_X + (VIEWPORT_W - scaledWidth) / 2;
        const y = VIEWPORT_Y + (VIEWPORT_H - scaledHeight) / 2;

        // Clip to viewport
        ctx.save();
        ctx.beginPath();
        ctx.rect(VIEWPORT_X, VIEWPORT_Y, VIEWPORT_W, VIEWPORT_H);
        ctx.clip();
        ctx.drawImage(img, x, y, scaledWidth, scaledHeight);
        ctx.restore();

        resolve();
      };

      img.onerror = () => {
        console.warn('[ClubCardGenerator] Failed to load logo image');
        resolve();
      };

      img.src = logoUrl;
    });
  }
}
