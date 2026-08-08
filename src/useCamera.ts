import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export type CameraState = 'requesting' | 'live' | 'denied' | 'unavailable' | 'error';

type UseCameraResult = {
  videoRef: RefObject<HTMLVideoElement | null>;
  state: CameraState;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
};

export function useCamera(disabled = false): UseCameraResult {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef(0);
  const [state, setState] = useState<CameraState>(disabled ? 'unavailable' : 'requesting');
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    requestIdRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(async () => {
    if (disabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unavailable');
      setError('Bu tarayıcı kamera erişimini desteklemiyor.');
      return;
    }

    setState('requesting');
    setError(null);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (requestId !== requestIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setState('live');
    } catch (cameraError) {
      if (requestId !== requestIdRef.current) return;
      const name = cameraError instanceof DOMException ? cameraError.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setState('denied');
        setError('Kamera izni kapalı. Tarayıcı ayarlarından izin verip yeniden dene.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setState('unavailable');
        setError('Bu cihazda kullanılabilir bir kamera bulunamadı.');
      } else {
        setState('error');
        setError('Kamera açılamadı. Bağlantının HTTPS olduğundan emin ol.');
      }
    }
  }, [disabled, stop]);

  useEffect(() => {
    if (!disabled) void start();
    return stop;
  }, [disabled, start, stop]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) stop();
      else if (!disabled && (state === 'live' || state === 'requesting')) void start();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [disabled, start, state, stop]);

  return { videoRef, state, error, start, stop };
}
