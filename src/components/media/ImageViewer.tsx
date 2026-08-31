import React, { useState } from 'react';
import './ImageViewer.css';

interface ImageViewerProps {
  src: string;
  alt?: string;
  thumbnail?: string;
  aspectRatio?: '1:1' | '4:3' | '16:9';
}

export const ImageViewer: React.FC<ImageViewerProps> = ({
  src,
  alt = 'Image',
  thumbnail,
  aspectRatio = '16:9',
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <>
      <div
        className={`image-viewer-thumb ratio-${aspectRatio.replace(':', '-')}`}
        onClick={() => setIsExpanded(true)}
      >
        {error ? (
          <div className="image-error">Failed To Load</div>
        ) : (
          <img
            loading="lazy"
            decoding="async"
            src={thumbnail || src}
            alt={alt}
            onError={() => setError(true)}
          />
        )}
      </div>

      {isExpanded && (
        <div className="image-viewer-overlay" onClick={() => setIsExpanded(false)}>
          <img loading="lazy" decoding="async" src={src} alt={alt} className="image-viewer-full" />
          <button className="image-viewer-close" aria-label="Close Image Viewer">
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default ImageViewer;
