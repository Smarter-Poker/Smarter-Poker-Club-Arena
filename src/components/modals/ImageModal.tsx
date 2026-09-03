import React, { useEffect } from 'react';
import './ImageModal.css';

interface ImageModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  alt?: string;
  caption?: string;
}

export const ImageModal: React.FC<ImageModalProps> = ({
  isOpen,
  onClose,
  imageUrl,
  alt = 'Image',
  caption,
}) => {
  // Escape-to-close keyboard handler
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="image-modal-overlay" onClick={onClose}>
      <button className="image-close" onClick={onClose}>
        ×
      </button>
      <div className="image-container" onClick={(e) => e.stopPropagation()}>
        <img loading="lazy" decoding="async" src={imageUrl} alt={alt} />
        {caption && <p className="image-caption">{caption}</p>}
      </div>
    </div>
  );
};

export default ImageModal;
