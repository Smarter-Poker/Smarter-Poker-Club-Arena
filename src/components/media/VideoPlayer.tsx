import React, { useRef, useState } from 'react';
import './VideoPlayer.css';

interface VideoPlayerProps {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  controls?: boolean;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  poster,
  autoPlay = false,
  controls = true,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(autoPlay);

  const togglePlay = () => {
    if (videoRef.current) {
      if (playing) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setPlaying(!playing);
    }
  };

  return (
    <div className="video-player">
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        autoPlay={autoPlay}
        controls={controls}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {!controls && (
        <button className="video-play-btn" onClick={togglePlay}>
          {playing ? '▮' : '▶'}
        </button>
      )}
    </div>
  );
};

export default VideoPlayer;
