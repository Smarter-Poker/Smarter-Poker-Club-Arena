/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LINK PREVIEW — URL Unfurling in Messages
 * ═══════════════════════════════════════════════════════════════════════════════
 * Renders a rich preview card for URLs found in message content.
 * Falls back to a domain + favicon display.
 */

import { useState, useEffect, memo } from 'react';
import styles from './LinkPreview.module.css';

interface LinkPreviewProps {
  url: string;
}

interface PreviewData {
  title: string;
  description?: string;
  image?: string;
  domain: string;
  favicon?: string;
}

// Simple URL extraction regex
export const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

/**
 * Extract first URL from message content
 */
export function extractUrl(content: string): string | null {
  const match = content.match(URL_REGEX);
  return match ? match[0] : null;
}

function LinkPreviewInner({ url }: LinkPreviewProps) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      try {
        // Use a proxy/API for OG meta fetching
        // Falls back to basic domain display
        const urlObj = new URL(url);
        const domain = urlObj.hostname.replace('www.', '');

        // Try to fetch OG data via a proxy (optional - graceful degradation)
        // For now, use basic domain info as fallback
        if (!cancelled) {
          setPreview({
            title: domain,
            domain: domain,
            favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
          });
        }
      } catch (err) {

        console.error("[LinkPreview] Error:", err);
        if (!cancelled) setError(true);
      }
      if (!cancelled) setLoading(false);
    };

    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error || loading) return null;
  if (!preview) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.container}
      onClick={(e) => e.stopPropagation()}
    >
      {preview.image && (
        <div className={styles.imageContainer}>
          <img src={preview.image} alt="" className={styles.image} />
        </div>
      )}
      <div className={styles.content}>
        <div className={styles.domainRow}>
          {preview.favicon && <img src={preview.favicon} alt="" className={styles.favicon} />}
          <span className={styles.domain}>{preview.domain}</span>
        </div>
        {preview.title && preview.title !== preview.domain && (
          <p className={styles.title}>{preview.title}</p>
        )}
        {preview.description && <p className={styles.description}>{preview.description}</p>}
      </div>
      <span className={styles.arrow}>↗</span>
    </a>
  );
}

const LinkPreview = memo(LinkPreviewInner);
export default LinkPreview;
