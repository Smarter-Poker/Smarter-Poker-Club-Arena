/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ClubCardGenerator — Template-Based Club/Union Card Compositing
 * ═══════════════════════════════════════════════════════════════════════════════
 * Generates club/union cards by:
 * 1. Drawing a dark metallic background with CSS-like gradients
 * 2. Drawing the ID plate zone at top
 * 3. Fitting the user's logo/AI image into the center viewport
 * 4. Drawing the name plate zone
 * 5. Drawing the stats bar with stat labels (MEMBERS, LEVEL, ACTIVE)
 * Returns as data URL
 *
 * Uses 3:4 aspect ratio to match the new ClubCardPanel layout.
 */

interface CardGeneratorOptions {
  logoUrl: string;
  clubId: number;
  clubName: string;
  entityType?: 'club' | 'union';
}

// Card dimensions — 3:4 aspect ratio
const CARD_WIDTH = 600;
const CARD_HEIGHT = 800;

// Zone heights (proportional to design)
const ID_PLATE_HEIGHT = 64; // ~8%
const STATS_BAR_HEIGHT = 160; // ~20% — stats only, no badge pill
const NAME_PLATE_HEIGHT = 96; // ~12%
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
    const { logoUrl, clubId, clubName, entityType = 'club' } = options;
    const isUnion = entityType === 'union';

    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ctx = canvas.getContext('2d')!;

    // Draw card background
    this.drawBackground(ctx, isUnion);

    // Draw Zone 1: ID Plate
    this.drawIdPlate(ctx, clubId, isUnion);

    // Draw Zone 2: Viewport background
    this.drawViewportBg(ctx);

    // Draw logo/image in viewport
    await this.drawLogo(ctx, logoUrl);

    // Draw Zone 3: Name Plate
    this.drawNamePlate(ctx, clubName);

    // Draw Zone 4: Stats Bar placeholder (actual stats are CSS overlays)
    this.drawStatsBar(ctx, isUnion);

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
   * Zone 1: ID Plate
   */
  private static drawIdPlate(ctx: CanvasRenderingContext2D, clubId: number, isUnion: boolean) {
    // Background
    const gradient = ctx.createLinearGradient(0, 0, 0, ID_PLATE_HEIGHT);
    gradient.addColorStop(0, 'rgba(50, 65, 95, 0.7)');
    gradient.addColorStop(1, 'rgba(30, 42, 68, 0.85)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CARD_WIDTH, ID_PLATE_HEIGHT);

    // Bottom border
    ctx.strokeStyle = 'rgba(100, 140, 200, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, ID_PLATE_HEIGHT);
    ctx.lineTo(CARD_WIDTH, ID_PLATE_HEIGHT);
    ctx.stroke();

    // Text
    const label = isUnion ? 'UNION ID' : 'CLUB ID';
    ctx.font = 'bold 22px "Orbitron", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = isUnion ? '#f0d070' : '#d0d8e8';
    ctx.fillText(`${label}: ${clubId}`, CARD_WIDTH / 2, ID_PLATE_HEIGHT / 2);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
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
        console.error('[ClubCardGenerator] Failed to load logo image');
        resolve();
      };

      img.src = logoUrl;
    });
  }

  /**
   * Zone 3: Name Plate
   */
  private static drawNamePlate(ctx: CanvasRenderingContext2D, clubName: string) {
    const nameY = VIEWPORT_Y + VIEWPORT_H;

    // Background
    const gradient = ctx.createLinearGradient(0, nameY, 0, nameY + NAME_PLATE_HEIGHT);
    gradient.addColorStop(0, 'rgba(18, 28, 50, 0.9)');
    gradient.addColorStop(1, 'rgba(12, 20, 38, 0.95)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, nameY, CARD_WIDTH, NAME_PLATE_HEIGHT);

    // Top border
    ctx.strokeStyle = 'rgba(100, 140, 200, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, nameY);
    ctx.lineTo(CARD_WIDTH, nameY);
    ctx.stroke();

    // Text — auto-size based on name length
    let fontSize = 32;
    if (clubName.length > 12) fontSize = 28;
    if (clubName.length > 18) fontSize = 24;
    if (clubName.length > 24) fontSize = 20;

    ctx.font = `bold ${fontSize}px "Orbitron", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(clubName, CARD_WIDTH / 2, nameY + NAME_PLATE_HEIGHT / 2);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  /**
   * Zone 4: Stats Bar (dark background — actual values are CSS overlays)
   */
  private static drawStatsBar(ctx: CanvasRenderingContext2D, isUnion: boolean) {
    const statsY = CARD_HEIGHT - STATS_BAR_HEIGHT;

    // Background
    const gradient = ctx.createLinearGradient(0, statsY, 0, CARD_HEIGHT);
    gradient.addColorStop(0, 'rgba(10, 18, 32, 0.95)');
    gradient.addColorStop(1, 'rgba(8, 14, 28, 1)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, statsY, CARD_WIDTH, STATS_BAR_HEIGHT);

    // Top border line
    ctx.strokeStyle = 'rgba(100, 140, 200, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, statsY);
    ctx.lineTo(CARD_WIDTH, statsY);
    ctx.stroke();

    // Stat labels — no badge pill, just labels + value placeholders
    const labelColor = isUnion ? '#e8d090' : '#a5eff0';
    const labelY = statsY + 24;
    ctx.font = 'bold 14px "Inter", "Roboto", sans-serif';
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillText('MEMBERS', CARD_WIDTH * 0.2, labelY);
    ctx.fillText('LEVEL', CARD_WIDTH * 0.5, labelY);
    ctx.fillText('ACTIVE', CARD_WIDTH * 0.8, labelY);
  }
}
