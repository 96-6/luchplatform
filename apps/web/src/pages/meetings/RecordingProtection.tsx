import { useEffect, useRef, useState } from 'react';
import { VideoTrack, type TrackReference } from '@livekit/components-react';
import { t } from '../../i18n';

export function RecordingProtectionNotice() {
  return (
    <aside className="recording-protection-notice" role="note">
      <strong>{t('Защита от записи видеозвонка включена')}</strong>
      <p>
        {t(
          'На видео отображаются ваше имя и код подключения. Не записывайте и не распространяйте встречу без разрешения. Веб-защита не блокирует OBS и системные скриншоты.',
        )}
      </p>
    </aside>
  );
}

// Deterrence only: DOM overlays and media attributes cannot prevent OS-level capture.
// Keep a copy inside each tile so application fullscreen retains the viewer's mark.
export function RecordingWatermark({ viewer }: { viewer: string }) {
  const [time, setTime] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toISOString()), 15000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="meeting-watermarks" aria-hidden="true" data-testid="recording-watermark">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i}>
          LUCH · {viewer}
          <br />
          {time.slice(0, 19).replace('T', ' ')} UTC
        </span>
      ))}
    </div>
  );
}

export function MeetingVideoTrack({
  trackRef,
  protected: enabled,
}: {
  trackRef: TrackReference;
  protected: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!enabled) return;
    // Also close an existing PiP window when protection is enabled during a call.
    if (document.pictureInPictureElement === video.current && document.exitPictureInPicture)
      void document.exitPictureInPicture().catch(() => {});
  }, [enabled]);
  return (
    <VideoTrack
      ref={video}
      trackRef={trackRef}
      playsInline
      controls={false}
      disablePictureInPicture={enabled}
      disableRemotePlayback={enabled}
      controlsList={enabled ? 'nodownload noremoteplayback nofullscreen' : undefined}
      onContextMenu={(event) => {
        if (enabled) event.preventDefault();
      }}
      onDragStart={(event) => {
        if (enabled) event.preventDefault();
      }}
    />
  );
}
