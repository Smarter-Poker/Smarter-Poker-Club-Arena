/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LogoGeneratorService — AI-Powered Club Logo Generation using Grok (xAI)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Generates custom club logos using xAI's Grok image generation API.
 * Outputs square images sized for the ClubCardGenerator (340x340 logo area).
 *
 * Migrated from OpenAI DALL-E to Grok grok-2-image-1212 (Jan 2026)
 * Deploy trigger: 1769680400
 */

// Logo generation via server-side API route (keeps xAI key server-side)
import { reportError } from '../utils/errorReporter';
const LOGO_API_URL = '/api/club-arena/generate-logo';

// Logo generation settings
const TARGET_LOGO_SIZE = 340; // Final size for ClubCardGenerator

export interface LogoGenerationOptions {
  clubName: string;
  style?: 'modern' | 'classic' | 'aggressive' | 'elegant' | 'playful';
  theme?: string; // e.g., "shark", "dragon", "phoenix", "poker chips"
  colorScheme?: string; // e.g., "blue and gold", "red and black"
}

export interface LogoGenerationResult {
  success: boolean;
  logoUrl?: string; // Data URL of the generated logo
  error?: string;
}

/**
 * Generate a club logo using xAI's Grok image generation API
 */
export async function generateClubLogo(
  options: LogoGenerationOptions
): Promise<LogoGenerationResult> {
  const { clubName, style = 'modern', theme, colorScheme } = options;

  try {
    // Call server-side API route (xAI key stays server-side, never in client bundle)
    const response = await fetch(LOGO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clubName, style, theme, colorScheme }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      reportError(data.error, 'LogoGeneratorService.generate.api');
      return {
        success: false,
        error: data.error || `API error: ${response.status}`,
      };
    }

    // Resize the returned data URL to target dimensions
    const resizedDataUrl = await resizeImage(data.logoUrl, TARGET_LOGO_SIZE, TARGET_LOGO_SIZE);

    return {
      success: true,
      logoUrl: resizedDataUrl,
    };
  } catch (error: unknown) {
    reportError(error, 'LogoGeneratorService.generate');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Resize an image to target dimensions using canvas
 */
async function resizeImage(
  dataUrl: string,
  targetWidth: number,
  targetHeight: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d')!;

      // Use high-quality image scaling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Draw the image scaled to target size
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Failed to load image for resizing'));
    img.src = dataUrl;
  });
}

/**
 * Logo style presets for quick selection
 */
export const LOGO_STYLE_PRESETS = [
  { id: 'shark-modern', name: 'Shark', theme: 'shark', style: 'aggressive' as const, icon: '🦈' },
  { id: 'dragon-classic', name: 'Dragon', theme: 'dragon', style: 'classic' as const, icon: '🐉' },
  { id: 'eagle-elegant', name: 'Eagle', theme: 'eagle', style: 'elegant' as const, icon: '🦅' },
  { id: 'lion-aggressive', name: 'Lion', theme: 'lion', style: 'aggressive' as const, icon: '🦁' },
  { id: 'phoenix-modern', name: 'Phoenix', theme: 'phoenix', style: 'modern' as const, icon: '🔥' },
  { id: 'wolf-classic', name: 'Wolf', theme: 'wolf', style: 'classic' as const, icon: '🐺' },
  {
    id: 'cards-elegant',
    name: 'Cards',
    theme: 'playing cards and poker chips',
    style: 'elegant' as const,
    icon: '🂡',
  },
  {
    id: 'crown-elegant',
    name: 'Crown',
    theme: 'royal crown with poker elements',
    style: 'elegant' as const,
    icon: '👑',
  },
  {
    id: 'diamond-modern',
    name: 'Diamond',
    theme: 'diamond gemstone',
    style: 'modern' as const,
    icon: '💎',
  },
  {
    id: 'skull-aggressive',
    name: 'Skull',
    theme: 'skull with poker elements',
    style: 'aggressive' as const,
    icon: '💀',
  },
  { id: 'tiger-playful', name: 'Tiger', theme: 'tiger', style: 'playful' as const, icon: '🐯' },
  {
    id: 'spade-classic',
    name: 'Spade',
    theme: 'spade suit symbol',
    style: 'classic' as const,
    icon: '♠️',
  },
];
