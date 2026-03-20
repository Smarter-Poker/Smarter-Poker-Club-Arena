/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ClubCardGenerator — Template-Based Club Card Compositing
 * ═══════════════════════════════════════════════════════════════════════════════
 * Generates club cards by:
 * 1. Loading the high-fidelity metallic frame template
 * 2. Fitting the user's logo/AI image into the center area
 * 3. Overlaying Club ID at top with white text
 * 4. Overlaying Club Name at bottom with white text
 * 5. Returns as data URL
 */

interface CardGeneratorOptions {
  logoUrl: string;
  clubId: number;
  clubName: string;
}

// Template image path (high-fidelity metallic frame)
const FRAME_TEMPLATE_URL = `${import.meta.env.BASE_URL}images/club-card-frame-template.jpg`;

// Card dimensions (matching actual frame template proportions 585:1024)
const CARD_WIDTH = 585;
const CARD_HEIGHT = 1024;

// Logo/image area: recessed viewport inside the metal frame
// Measured from club-card-frame-template.jpg:
//   top: ~6%, left: ~7%, right: ~7%, bottom: ~75%
const LOGO_X = Math.round(CARD_WIDTH * 0.07); // 42
const LOGO_Y = Math.round(CARD_HEIGHT * 0.06); // 61
const LOGO_WIDTH = CARD_WIDTH - LOGO_X * 2; // 520
const LOGO_HEIGHT = Math.round(CARD_HEIGHT * 0.69); // 707 (75% - 6%)

// Text positions
const CLUB_ID_Y = Math.round(CARD_HEIGHT * 0.04); // Near top of frame
const CLUB_NAME_Y = Math.round(CARD_HEIGHT * 0.7); // Below the image, before stats bar

export class ClubCardGenerator {
  /**
   * Generate a complete club card with logo, ID, and name
   */
  static async generateCard(options: CardGeneratorOptions): Promise<string> {
    const { logoUrl, clubId, clubName } = options;

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ctx = canvas.getContext('2d')!;

    // Load and draw the frame template as background
    await this.drawFrameTemplate(ctx);

    // Draw logo/AI image in center area
    await this.drawLogo(ctx, logoUrl);

    // Draw Club ID at top with white text
    this.drawClubId(ctx, clubId);

    // Draw Club Name at bottom with white text
    this.drawClubName(ctx, clubName);

    return canvas.toDataURL('image/png');
  }

  /**
   * Load and draw the high-fidelity frame template
   */
  private static async drawFrameTemplate(ctx: CanvasRenderingContext2D): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        // Draw template scaled to canvas size
        ctx.drawImage(img, 0, 0, CARD_WIDTH, CARD_HEIGHT);
        resolve();
      };

      img.onerror = () => {
        // Fallback: draw dark background if template fails to load
        console.error('[ClubCardGenerator] Failed to load frame template, using fallback');
        const gradient = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
        gradient.addColorStop(0, '#1a2744');
        gradient.addColorStop(0.5, '#0d1b2a');
        gradient.addColorStop(1, '#1a2744');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
        resolve();
      };

      img.src = FRAME_TEMPLATE_URL;
    });
  }

  /**
   * Draw the user's logo/AI image, scaled to fit the center area
   */
  private static async drawLogo(ctx: CanvasRenderingContext2D, logoUrl: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        // Cover-fill: scale to fill the entire logo area (matches Shark Club standard)
        const scale = Math.max(LOGO_WIDTH / img.width, LOGO_HEIGHT / img.height);
        const scaledWidth = img.width * scale;
        const scaledHeight = img.height * scale;

        // Center the image over the logo area (excess is clipped by the frame)
        const x = LOGO_X + (LOGO_WIDTH - scaledWidth) / 2;
        const y = LOGO_Y + (LOGO_HEIGHT - scaledHeight) / 2;

        // Clip to the logo area bounds so the image doesn't bleed over the frame
        ctx.save();
        ctx.beginPath();
        ctx.rect(LOGO_X, LOGO_Y, LOGO_WIDTH, LOGO_HEIGHT);
        ctx.clip();

        // Draw the image
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
   * Draw Club ID text at top with white letters
   */
  private static drawClubId(ctx: CanvasRenderingContext2D, clubId: number) {
    ctx.font = 'bold 26px "Orbitron", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Text shadow for readability on dark/busy background
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    // White text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`CLUB ID: ${clubId}`, CARD_WIDTH / 2, CLUB_ID_Y);

    // Reset shadow
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  /**
   * Draw Club Name text at bottom with white letters
   */
  private static drawClubName(ctx: CanvasRenderingContext2D, clubName: string) {
    // Calculate font size based on name length
    let fontSize = 32;
    if (clubName.length > 12) fontSize = 28;
    if (clubName.length > 18) fontSize = 24;
    if (clubName.length > 24) fontSize = 20;

    ctx.font = `bold ${fontSize}px "Orbitron", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Text shadow for readability
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    // White text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(clubName, CARD_WIDTH / 2, CLUB_NAME_Y);

    // Reset shadow
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
}
