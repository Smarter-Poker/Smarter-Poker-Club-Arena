/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  IMAGE MESSAGE — Image sharing with preview, lightbox, and upload handling
 * ═══════════════════════════════════════════════════════════════════════════════
 * Features: Upload preview, thumbnail display, lightbox with pinch-to-zoom, loading shimmer
 */

import { useState, useRef, useEffect } from 'react';
import { useToast } from '../common/Toast';
import styles from './ImageMessage.module.css';

interface ImageMessageProps {
  imageUrl: string;
  isLoading?: boolean;
  onClose?: () => void;
  showLightbox?: boolean;
}

interface ImageUploadProps {
  onPreview: (dataUrl: string | null) => void;
  maxSizeMB?: number;
}

/**
 * ImageUpload — File input with preview and validation
 */
export function ImageUpload({ onPreview, maxSizeMB = 5 }: ImageUploadProps) {
  const toast = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxSizeBytes = maxSizeMB * 1024 * 1024;

  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > maxSizeBytes) {
      toast.error(`File size must be less than ${maxSizeMB}MB`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      onPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  return (
    <label
      className={`${styles.uploadBtn} ${isDragging ? styles.dragging : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      title={`Upload image (max ${maxSizeMB}MB)`}
    >
      📷
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleChange} hidden />
    </label>
  );
}

/**
 * ImagePreview — Shows preview before sending with cancel option
 */
export function ImagePreview({ imageUrl, onRemove }: { imageUrl: string; onRemove: () => void }) {
  return (
    <div className={styles.previewContainer}>
      <div className={styles.previewWrapper}>
        <img
          loading="lazy"
          decoding="async"
          src={imageUrl}
          alt="Preview"
          className={styles.previewImage}
        />
        <button className={styles.removePreviewBtn} onClick={onRemove} title="Remove preview">
          ✕
        </button>
      </div>
      <p className={styles.previewHint}>Ready to send</p>
    </div>
  );
}

/**
 * ImageThumbnail — Clickable thumbnail that opens lightbox
 */
export function ImageThumbnail({ imageUrl, onClick }: { imageUrl: string; onClick: () => void }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className={`${styles.thumbnail} ${loaded ? styles.loaded : styles.loading}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
    >
      {!loaded && <div className={styles.shimmer} />}
      <img
        loading="lazy"
        decoding="async"
        src={imageUrl}
        alt="Message image"
        className={styles.thumbnailImage}
        onLoad={() => setLoaded(true)}
      />
      <div className={styles.zoomIcon}>🔍</div>
    </div>
  );
}

/**
 * ImageLightbox — Full-screen image viewer with zoom
 */
export function ImageLightbox({ imageUrl, onClose }: { imageUrl: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const touchStartRef = useRef<{ x: number; y: number; distance: number }>({
    x: 0,
    y: 0,
    distance: 0,
  });

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') zoomIn();
      if (e.key === '-') zoomOut();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [scale, onClose]);

  const zoomIn = () => setScale((s) => Math.min(s + 0.2, 4));
  const zoomOut = () => setScale((s) => Math.max(s - 0.2, 1));

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale === 1) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || scale === 1) return;
    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;
    setPosition({ x: newX, y: newY });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Pinch zoom for touch
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      touchStartRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
        distance,
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const newDistance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );
      const delta = (newDistance - touchStartRef.current.distance) / 100;
      setScale((s) => Math.max(1, Math.min(4, s + delta)));
    }
  };

  return (
    <div
      className={styles.lightboxOverlay}
      onClick={onClose}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div className={styles.lightboxContent} onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button className={styles.lightboxClose} onClick={onClose}>
          ✕
        </button>

        {/* Image container */}
        <div className={styles.imageContainer}>
          <img
            loading="lazy"
            decoding="async"
            ref={imgRef}
            src={imageUrl}
            alt="Full size"
            className={styles.lightboxImage}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            style={{
              transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
              cursor: isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'default',
            }}
          />
        </div>

        {/* Controls */}
        <div className={styles.lightboxControls}>
          <button
            className={styles.controlBtn}
            onClick={zoomOut}
            disabled={scale === 1}
            title="Zoom out (-)"
          >
            −
          </button>
          <span className={styles.zoomLevel}>{Math.round(scale * 100)}%</span>
          <button
            className={styles.controlBtn}
            onClick={zoomIn}
            disabled={scale === 4}
            title="Zoom in (+)"
          >
            +
          </button>
          <div className={styles.divider} />
          <span className={styles.hint}>Drag to pan • Pinch to zoom • ESC to close</span>
        </div>
      </div>
    </div>
  );
}

/**
 * ImageMessage — Main component for image display in messages
 */
export default function ImageMessage({
  imageUrl,
  isLoading = false,
  showLightbox = false,
  onClose,
}: ImageMessageProps) {
  const [showFullscreen, setShowFullscreen] = useState(showLightbox);

  return (
    <>
      {isLoading ? (
        <div className={styles.loadingPlaceholder}>
          <div className={styles.shimmer} />
          <span className={styles.uploadingText}>Uploading...</span>
        </div>
      ) : (
        <ImageThumbnail imageUrl={imageUrl} onClick={() => setShowFullscreen(true)} />
      )}

      {showFullscreen && (
        <ImageLightbox
          imageUrl={imageUrl}
          onClose={() => {
            setShowFullscreen(false);
            onClose?.();
          }}
        />
      )}
    </>
  );
}
