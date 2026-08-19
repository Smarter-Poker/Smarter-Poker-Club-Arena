/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ VOICE RECORDER — Q3 Wave 3 (Block E)
 * Web Audio API voice message recorder with waveform visualizer
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { haptic } from '../../services/HapticService';
import './VoiceRecorder.css';
import { reportError } from '../../utils/errorReporter';

interface VoiceRecorderProps {
  onSend: (audioBlob: Blob, durationMs: number) => void;
  onCancel: () => void;
}

type RecordingState = 'idle' | 'recording' | 'preview';

export const VoiceRecorder: React.FC<VoiceRecorderProps> = ({ onSend, onCancel }) => {
  const [state, setState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [waveformLevels, setWaveformLevels] = useState<number[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioBlobRef = useRef<Blob | null>(null);

  // Track audioUrl in a ref for cleanup (avoids stale closure)
  const audioUrlRef = useRef<string | null>(null);
  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);

  // Cleanup on unmount ONLY — kill timers, animation frames, media tracks, and revoke URL
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      stopMediaTracks();
    };
  }, []);

  const stopMediaTracks = () => {
    if (mediaRecorderRef.current?.stream) {
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    }
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      haptic.medium();

      // Audio context for waveform
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      // MediaRecorder
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        audioBlobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setState('preview');
        audioCtx.close();
      };

      recorder.start(100); // 100ms chunks for smoother data
      mediaRecorderRef.current = recorder;
      startTimeRef.current = Date.now();
      setState('recording');

      // Duration counter
      durationTimerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 100);

      // Waveform animation
      const drawWaveform = () => {
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);

        const levels = Array.from(dataArray.slice(0, 20)).map((v) => v / 255);
        setWaveformLevels(levels);

        if (mediaRecorderRef.current?.state === 'recording') {
          animFrameRef.current = requestAnimationFrame(drawWaveform);
        }
      };
      drawWaveform();
    } catch (err) {
      reportError(err, 'VoiceRecorder.Mic_access_denied');
      haptic.error();
      onCancel();
    }
  }, [onCancel]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      stopMediaTracks();
    }
    if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    haptic.light();
  }, []);

  const handleSend = useCallback(() => {
    if (audioBlobRef.current) {
      haptic.success();
      const totalMs = Date.now() - startTimeRef.current;
      onSend(audioBlobRef.current, totalMs);
    }
  }, [onSend]);

  const handleCancel = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      stopMediaTracks();
    }
    if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    audioBlobRef.current = null;
    setState('idle');
    setDuration(0);
    setWaveformLevels([]);
    onCancel();
  }, [audioUrl, onCancel]);

  const formatDuration = (secs: number): string => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins}:${s.toString().padStart(2, '0')}`;
  };

  // Auto-start recording on mount
  useEffect(() => {
    startRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="voice-recorder">
      {state === 'recording' && (
        <div className="voice-recording-bar">
          <span className="recording-pulse" />
          <span className="recording-time">{formatDuration(duration)}</span>

          {/* Waveform */}
          <div className="waveform-container">
            {waveformLevels.map((level, i) => (
              <div
                key={i}
                className="waveform-bar"
                style={{ height: `${Math.max(4, level * 32)}px` }}
              />
            ))}
          </div>

          <button className="voice-cancel-btn" onClick={handleCancel}>
            ✕
          </button>
          <button className="voice-stop-btn" onClick={stopRecording}>
            ■
          </button>
        </div>
      )}

      {state === 'preview' && (
        <div className="voice-preview-bar">
          {audioUrl && <audio src={audioUrl} controls className="voice-audio-player" />}
          <span className="preview-duration">{formatDuration(duration)}</span>
          <button className="voice-cancel-btn" onClick={handleCancel}>
            ✕
          </button>
          <button className="voice-send-btn" onClick={handleSend}>
            Send
          </button>
        </div>
      )}
    </div>
  );
};

export default VoiceRecorder;
