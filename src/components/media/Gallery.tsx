import React, { useState } from 'react';
import './Gallery.css';

interface GalleryProps {
  images: { src: string; alt?: string }[];
  columns?: 2 | 3 | 4;
}

export const Gallery: React.FC<GalleryProps> = ({ images, columns = 3 }) => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedIndex !== null) {
      setSelectedIndex(selectedIndex === 0 ? images.length - 1 : selectedIndex - 1);
    }
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedIndex !== null) {
      setSelectedIndex(selectedIndex === images.length - 1 ? 0 : selectedIndex + 1);
    }
  };

  return (
    <div className={`gallery columns-${columns}`}>
      {images.map((img, idx) => (
        <div key={idx} className="gallery-item" onClick={() => setSelectedIndex(idx)}>
          <img loading="lazy" decoding="async" src={img.src} alt={img.alt || `Image ${idx + 1}`} />
        </div>
      ))}

      {selectedIndex !== null && (
        <div className="gallery-lightbox" onClick={() => setSelectedIndex(null)}>
          <button className="gallery-nav prev" onClick={handlePrev}>
            ‹
          </button>
          <img loading="lazy" decoding="async" src={images[selectedIndex].src} alt="" />
          <button className="gallery-nav next" onClick={handleNext}>
            ›
          </button>
          <span className="gallery-counter">
            {selectedIndex + 1} / {images.length}
          </span>
        </div>
      )}
    </div>
  );
};

export default Gallery;
