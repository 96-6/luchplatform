import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  VideoTrack,
  useRoomContext,
  useParticipants,
  useTracks,
  useLocalParticipant,
  useConnectionState,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client';
import {
  meetingSchema,
  joinMeetingSchema,
  meetingTokenSchema,
  roomStateSchema,
  meetingMessagesSchema,
  type Meeting,
  type MeetingSession,
  type MeetingRoomState,
  type moderateMeetingSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import { useAuth } from '../../auth/AuthContext';
import { api, ApiError } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { ErrorState, LoadingState } from '../../components/States';
import { usePolling, okSchema, meetingTime } from './shared';
export function MeetingRoomPage() {
  const { id } = useParams();
  return <RoomEntry key={id} id={id!} />;
}
function RoomEntry({ id }: { id: string }) {
  const { state, refresh } = useResource(`/meetings/${id}`, meetingSchema),
    [joined, setJoined] = useState<MeetingSession | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<string | null>(null);
  async function enter() {
    setBusy(true);
    setError('');
    try {
      pending.current ??= crypto.randomUUID();
      const result = await api(`/meetings/${id}/join`, joinMeetingSchema, {
        body: { operationId: pending.current },
      });
      setJoined(result.session);
      pending.current = null;
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status && e.status < 500) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  if (joined)
    return (
      <JoinedRoom
        id={id}
        initialSession={joined}
        left={() => {
          setJoined(null);
          refresh();
        }}
      />
    );
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const m = state.data;
  return (
    <>
      <Link to={`/meetings/${id}`}>← Карточка занятия</Link>
      <h1>{m.title}</h1>
      <section className="panel meeting-prejoin">
        <h2>Присоединение к видеозанятию</h2>
        <p>
          {meetingTime(m)} · {m.timeZone}
        </p>
        <p>
          Камера и микрофон при входе выключены. Вы сможете включить их и выбрать устройства в
          комнате.
        </p>
        <p>
          Организаторы и суперадмин видят признаки виртуальных активных устройств. Это
          предварительные сигналы по названию устройства, которые не влияют на оценку.
        </p>
        {m.lobbyEnabled && !m.canManage && <p>Организатор допустит вас из зала ожидания.</p>}
        <button disabled={busy || !m.canJoin || !m.videoConfigured} onClick={() => void enter()}>
          {busy
            ? 'Подключаем…'
            : pending.current
              ? 'Повторить подключение'
              : m.canManage && m.status === 'scheduled'
                ? 'Начать встречу'
                : 'Войти во встречу'}
        </button>
        {!m.videoConfigured && (
          <p role="status">
            Видеосвязь пока не подключена администратором. Расписание и учебные результаты
            сохранены.
          </p>
        )}
        {!m.canJoin && <p>Вход недоступен: проверьте срок и статус занятия.</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
function JoinedRoom({
  id,
  initialSession,
  left,
}: {
  id: string;
  initialSession: MeetingSession;
  left: () => void;
}) {
  const state = usePolling(
    `/meetings/${id}/room-state?sessionId=${initialSession.id}`,
    roomStateSchema,
    1500,
  );
  const [token, setToken] = useState<z.infer<typeof meetingTokenSchema> | null>(null),
    [tokenError, setTokenError] = useState<Error | null>(null),
    [epoch, setEpoch] = useState(0),
    [leaving, setLeaving] = useState(false),
    [disconnected, setDisconnected] = useState(false);
  const fetching = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fetchToken = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setTokenError(null);
    try {
      const value = await api(
        `/meetings/${id}/sessions/${initialSession.id}/token`,
        meetingTokenSchema,
        { body: {} },
      );
      if (mounted.current) {
        setToken(value);
        setDisconnected(false);
        setEpoch((v) => v + 1);
      }
    } catch (e) {
      if (mounted.current) setTokenError(e as Error);
    } finally {
      fetching.current = false;
    }
  }, [id, initialSession.id]);
  const self = state.data?.self;
  const admitted = self?.state === 'admitted' && state.data?.meeting.status === 'live';
  useEffect(() => {
    if (admitted && !token && !tokenError) void fetchToken();
  }, [admitted, token, tokenError, fetchToken]);
  async function leave() {
    setLeaving(true);
    try {
      await api(`/meetings/${id}/sessions/${initialSession.id}/leave`, okSchema, {
        body: {},
        keepalive: true,
      });
      setToken(null);
      left();
    } catch (e) {
      setTokenError(e as Error);
    } finally {
      setLeaving(false);
    }
  }
  if (!state.data)
    return state.error ? (
      <ErrorState error={state.error} retry={() => void state.refresh()} />
    ) : (
      <LoadingState text="Проверяем допуск во встречу…" />
    );
  const data = state.data;
  const finished = ['completed', 'cancelled'].includes(data.meeting.status);
  return (
    <>
      <div className="meeting-title">
        <div>
          <Link to={`/meetings/${id}`}>← Карточка занятия</Link>
          <h1>{data.meeting.title}</h1>
        </div>
        <button className="secondary danger" disabled={leaving} onClick={() => void leave()}>
          {leaving ? 'Выходим…' : 'Покинуть встречу'}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="error">
          Состояние встречи не обновлено. {state.error.message}
        </p>
      )}
      {finished || self?.state === 'removed' || self?.state === 'left' ? (
        <section className="panel">
          <h2>
            {finished
              ? 'Встреча завершена'
              : self?.state === 'removed'
                ? 'Организатор удалил вас из встречи'
                : 'Вы вышли из встречи'}
          </h2>
          <Link to={`/meetings/${id}`}>Итоги и домашняя работа →</Link>
        </section>
      ) : self?.state === 'waiting' ? (
        <section className="panel" role="status">
          <h2>Зал ожидания</h2>
          <p>Ожидайте допуска организатора. Камера и микрофон выключены.</p>
        </section>
      ) : token && admitted ? (
        <LiveKitRoom
          key={epoch}
          serverUrl={token.serverUrl}
          token={token.token}
          connect
          audio={false}
          video={false}
          options={{ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true }}
          onConnected={() => {
            setDisconnected(false);
            void state.refresh();
          }}
          onDisconnected={() => setDisconnected(true)}
          onError={(e) => setTokenError(e)}
        >
          <Conference data={data} refresh={state.refresh} />
          <RoomAudioRenderer />
          <StartAudio label="Включить звук встречи" />
        </LiveKitRoom>
      ) : !tokenError ? (
        <LoadingState text="Подключаем видеосвязь…" />
      ) : null}
      {tokenError && <ErrorState error={tokenError} retry={() => void fetchToken()} />}{' '}
      {disconnected && admitted && (
        <p role="alert">
          Соединение разорвано.{' '}
          <button onClick={() => void fetchToken()}>Подключиться снова</button>
        </p>
      )}
    </>
  );
}
function Conference({ data, refresh }: { data: MeetingRoomState; refresh: () => Promise<void> }) {
  const room = useRoomContext(),
    peers = useParticipants(),
    tracks = useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { onlySubscribed: false },
    );
  const connection = useConnectionState(),
    { session } = useAuth();
  const [pinned, setPinned] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [ending, setEnding] = useState(false);
  const pending = useRef<z.infer<typeof moderateMeetingSchema> | null>(null);
  const self = data.self!;
  async function moderate(
    action: z.infer<typeof moderateMeetingSchema>['action'],
    targetId?: string,
  ) {
    setBusy(true);
    setError('');
    const body = pending.current ?? {
      operationId: crypto.randomUUID(),
      action,
      ...(targetId ? { targetId } : {}),
      ...(['lock', 'unlock', 'end', 'cancel'].includes(action)
        ? { revision: data.meeting.revision }
        : {}),
    };
    pending.current = body;
    try {
      await api(`/meetings/${data.meeting.id}/moderate`, meetingSchema, { body });
      pending.current = null;
      setEnding(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status && e.status < 500) {
        pending.current = null;
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  const screens = tracks.filter(
    (t) =>
      t.source === Track.Source.ScreenShare &&
      isTrackReference(t) &&
      t.publication.track &&
      !t.publication.isMuted,
  );
  return (
    <div className="conference" data-testid="video-conference">
      <p className="meeting-connection" role="status">
        {connection === ConnectionState.Connected
          ? 'Соединение установлено'
          : connection === ConnectionState.Reconnecting ||
              connection === ConnectionState.SignalReconnecting
            ? 'Восстанавливаем соединение…'
            : 'Подключение…'}{' '}
        · Участников: {peers.length}
      </p>
      {!data.available && (
        <p role="alert" className="error">
          Состояние видеосервиса временно недоступно. Управление будет повторено после
          восстановления.
        </p>
      )}
      {data.pendingCommands > 0 && (
        <p role="status" className="warning">
          Команд ожидает доставки: {data.pendingCommands}. Не считайте отключение подтверждённым до
          доставки.
        </p>
      )}
      <DeviceReporter id={data.meeting.id} sid={self.id} initialRevision={self.deviceRevision} />
      <MediaControls id={data.meeting.id} self={self} refresh={refresh} />
      {screens.length > 0 && (
        <section className="screen-stage" aria-label="Демонстрации экрана">
          {screens.map((t) => (
            <div key={t.participant.identity} className="screen-share">
              <p>Экран: {t.participant.name}</p>
              {isTrackReference(t) && <VideoTrack trackRef={t} />}
            </div>
          ))}
        </section>
      )}
      <div className="participant-grid" aria-label="Участники видеовстречи">
        {peers.map((p) => {
          const info = data.participants.find((x) => x.identity === p.identity),
            track = tracks.find(
              (t) => t.participant.identity === p.identity && t.source === Track.Source.Camera,
            );
          return (
            <article
              className={`participant-tile ${pinned === p.identity ? 'pinned' : ''} ${p.isSpeaking ? 'speaking' : ''}`}
              key={p.identity}
              data-testid="meeting-participant"
              data-identity={p.identity}
            >
              <div className="participant-top">
                <strong>
                  {info?.name ?? p.name ?? 'Участник'} {p.isLocal ? '(вы)' : ''}
                </strong>
                {info?.handRaisedAt && (
                  <span className="raised-hand" aria-label="Рука поднята">
                    ✋
                  </span>
                )}
                <DeviceWarnings info={info} />
              </div>
              {track &&
              isTrackReference(track) &&
              track.publication.track &&
              !track.publication.isMuted ? (
                <VideoTrack trackRef={track} />
              ) : (
                <div className="participant-placeholder" aria-label="Камера выключена">
                  {(info?.name ?? p.name ?? '?').slice(0, 1)}
                </div>
              )}
              <p className="participant-caption">
                {info?.role === 'organizer'
                  ? 'Организатор'
                  : info?.role === 'superadmin'
                    ? 'Суперадмин'
                    : info?.role === 'admin'
                      ? 'Администратор'
                      : 'Участник'}{' '}
                · {p.isMicrophoneEnabled ? 'Микрофон включён' : 'Микрофон выключен'}{' '}
                {p.isSpeaking ? '· Говорит' : ''}
              </p>
              <div className="participant-tools">
                <button
                  className="secondary"
                  onClick={() => setPinned((v) => (v === p.identity ? null : p.identity))}
                  aria-label={`${pinned === p.identity ? 'Открепить' : 'Закрепить'}: ${info?.name ?? p.name}`}
                >
                  {pinned === p.identity ? 'Открепить' : 'Закрепить'}
                </button>
                <button
                  className="secondary"
                  onClick={(e) =>
                    void e.currentTarget
                      .closest('article')
                      ?.requestFullscreen()
                      .catch(() => setError('Полноэкранный режим недоступен в этом браузере.'))
                  }
                >
                  На весь экран
                </button>
              </div>
              {data.meeting.canManage &&
                !p.isLocal &&
                info &&
                (info.role !== 'superadmin' || session.user!.role === 'superadmin') && (
                  <details className="participant-moderation">
                    <summary>Управление участником</summary>
                    <div className="button-row">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void moderate(
                            info.audioAllowed ? 'mute_audio' : 'allow_audio',
                            p.identity,
                          )
                        }
                      >
                        {info.audioAllowed ? 'Отключить микрофон' : 'Разрешить микрофон'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void moderate(
                            info.videoAllowed ? 'disable_video' : 'allow_video',
                            p.identity,
                          )
                        }
                      >
                        {info.videoAllowed ? 'Отключить камеру' : 'Разрешить камеру'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void moderate(
                            info.screenAllowed ? 'stop_screen' : 'allow_screen',
                            p.identity,
                          )
                        }
                      >
                        {info.screenAllowed ? 'Запретить демонстрацию' : 'Разрешить демонстрацию'}
                      </button>
                      {info.handRaisedAt && (
                        <button
                          disabled={busy}
                          onClick={() => void moderate('lower_hand', p.identity)}
                        >
                          Опустить руку участника
                        </button>
                      )}
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => void moderate('kick', p.identity)}
                      >
                        Удалить из встречи
                      </button>
                    </div>
                  </details>
                )}
            </article>
          );
        })}
      </div>
      {data.meeting.canManage && (
        <section className="panel meeting-moderation" aria-label="Управление встречей">
          <h2>Управление встречей</h2>
          <div className="button-row">
            <button disabled={busy} onClick={() => void moderate('mute_all')}>
              Отключить микрофоны учеников
            </button>
            <button
              disabled={busy}
              onClick={() => void moderate(data.meeting.locked ? 'unlock' : 'lock')}
            >
              {data.meeting.locked ? 'Открыть вход' : 'Закрыть вход'}
            </button>
            <button className="danger" disabled={busy} onClick={() => setEnding((v) => !v)}>
              Завершить встречу для всех
            </button>
          </div>
          {ending && (
            <div className="inline-message">
              <p>
                Все участники будут отключены. Итог и домашние задания сохраняются в карточке
                занятия.
              </p>
              <button className="danger" disabled={busy} onClick={() => void moderate('end')}>
                Подтвердить завершение для всех
              </button>
            </div>
          )}
          <h3>Зал ожидания · {data.waiting.length}</h3>
          {data.waiting.length ? (
            <ul className="meeting-agenda">
              {data.waiting.map((p) => (
                <li key={p.identity}>
                  <strong>{p.name}</strong>
                  <button disabled={busy} onClick={() => void moderate('admit', p.identity)}>
                    Допустить: {p.name}
                  </button>
                  <button
                    className="secondary danger"
                    disabled={busy}
                    onClick={() => void moderate('kick', p.identity)}
                  >
                    Отказать: {p.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>Ожидающих участников нет.</p>
          )}
          {data.meeting.members.some((m) => m.blocked) && (
            <details>
              <summary>Удалённые участники</summary>
              {data.meeting.members
                .filter((m) => m.blocked)
                .map((m) => (
                  <p key={m.id}>
                    {m.name}{' '}
                    <button disabled={busy} onClick={() => void moderate('restore', m.id)}>
                      Разрешить возврат: {m.name}
                    </button>
                  </p>
                ))}
            </details>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
          {pending.current && (
            <button
              disabled={busy}
              onClick={() => void moderate(pending.current!.action, pending.current!.targetId)}
            >
              Повторить команду
            </button>
          )}
        </p>
      )}
      <MeetingChat id={data.meeting.id} />
    </div>
  );
}
function DeviceWarnings({ info }: { info: MeetingRoomState['participants'][number] | undefined }) {
  const [opened, setOpened] = useState<'camera' | 'microphone' | null>(null);
  if (!info?.warnings.length) return null;
  return (
    <div className="device-warnings">
      {info.warnings.map((w) => (
        <div key={w.kind}>
          <button
            className="device-warning"
            title={
              w.kind === 'camera'
                ? 'Возможно, виртуальная камера'
                : 'Возможно, виртуальный микрофон'
            }
            aria-label={
              w.kind === 'camera'
                ? 'Предупреждение о виртуальной камере'
                : 'Предупреждение о виртуальном микрофоне'
            }
            aria-expanded={opened === w.kind}
            onClick={() => setOpened((v) => (v === w.kind ? null : w.kind))}
          >
            <svg
              viewBox="0 0 32 26"
              width="27"
              height="23"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              {w.kind === 'camera' ? (
                <>
                  <rect x="2" y="5" width="18" height="15" rx="3" />
                  <path d="m20 10 7-4v14l-7-4" />
                </>
              ) : (
                <>
                  <rect x="7" y="1" width="9" height="15" rx="4.5" />
                  <path d="M3 11v3a8 8 0 0 0 16 0v-3M11 22v3M6 25h10" />
                </>
              )}
              <circle cx="25" cy="6" r="6" fill="#fff7ed" />
              <path d="M25 2v5m0 2v1" />
            </svg>
          </button>
          {opened === w.kind && (
            <div role="note" className="device-warning-detail">
              <strong>
                Возможно, участник использует{' '}
                {w.kind === 'camera' ? 'виртуальную камеру' : 'виртуальный микрофон'} — «{w.label}».
              </strong>
              <p>
                Совпадение: {w.match}. Название сообщено браузером и может быть изменено. Это не
                доказательство нарушения и не влияет на оценку.
              </p>
              <small>
                Доступно организаторам и суперадмину ·{' '}
                {new Date(w.reportedAt).toLocaleTimeString('ru')}
              </small>
              <button className="secondary" onClick={() => setOpened(null)}>
                Закрыть сведения
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
function MediaControls({
  id,
  self,
  refresh,
}: {
  id: string;
  self: MeetingSession;
  refresh: () => Promise<void>;
}) {
  const room = useRoomContext(),
    { localParticipant, isCameraEnabled, isMicrophoneEnabled, isScreenShareEnabled } =
      useLocalParticipant();
  const [camera, setCamera] = useState(''),
    [mic, setMic] = useState(''),
    [speaker, setSpeaker] = useState(''),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const enumerate = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setError('Список устройств недоступен. Проверьте разрешения браузера.');
    }
  }, []);
  useEffect(() => {
    void enumerate();
    navigator.mediaDevices?.addEventListener('devicechange', enumerate);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', enumerate);
  }, [enumerate]);
  useEffect(() => {
    if (!self.audioAllowed && localParticipant.isMicrophoneEnabled)
      void localParticipant.setMicrophoneEnabled(false).catch(() => {});
    if (!self.videoAllowed && localParticipant.isCameraEnabled)
      void localParticipant.setCameraEnabled(false).catch(() => {});
    if (!self.screenAllowed && localParticipant.isScreenShareEnabled)
      void localParticipant.setScreenShareEnabled(false).catch(() => {});
  }, [self.audioAllowed, self.videoAllowed, self.screenAllowed, localParticipant]);
  async function act(kind: 'audio' | 'video' | 'screen') {
    setBusy(true);
    setError('');
    try {
      if (kind === 'audio')
        await localParticipant.setMicrophoneEnabled(
          !isMicrophoneEnabled,
          { ...(mic ? { deviceId: mic } : {}), echoCancellation: true, noiseSuppression: true },
          { name: 'microphone' },
        );
      else if (kind === 'video')
        await localParticipant.setCameraEnabled(
          !isCameraEnabled,
          camera ? { deviceId: camera } : {},
          { name: 'camera' },
        );
      else
        await localParticipant.setScreenShareEnabled(
          !isScreenShareEnabled,
          { audio: self.audioAllowed },
          { name: 'screen' },
        );
      await enumerate();
      await refresh();
    } catch {
      setError(
        kind === 'screen'
          ? 'Демонстрация не началась. Выберите экран или окно; при отказе разрешения можно повторить.'
          : 'Не удалось включить устройство. Проверьте разрешения камеры/микрофона и повторите. Учебная оценка не меняется.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function switchDevice(kind: MediaDeviceKind, value: string) {
    try {
      await room.switchActiveDevice(kind, value);
      if (kind === 'videoinput') setCamera(value);
      else if (kind === 'audioinput') setMic(value);
      else setSpeaker(value);
    } catch {
      setError('Не удалось переключить устройство. Попробуйте другое.');
    }
  }
  return (
    <section className="meeting-controls" aria-label="Камера, звук и демонстрация">
      <div className="button-row">
        <button
          aria-pressed={isMicrophoneEnabled}
          disabled={busy || !self.audioAllowed}
          onClick={() => void act('audio')}
        >
          {isMicrophoneEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
        </button>
        <button
          aria-pressed={isCameraEnabled}
          disabled={busy || !self.videoAllowed}
          onClick={() => void act('video')}
        >
          {isCameraEnabled ? 'Выключить камеру' : 'Включить камеру'}
        </button>
        <button
          aria-pressed={isScreenShareEnabled}
          disabled={busy || !self.screenAllowed}
          onClick={() => void act('screen')}
        >
          {isScreenShareEnabled ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
        </button>
        <button
          className="secondary"
          aria-pressed={Boolean(self.handRaisedAt)}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api(`/meetings/${id}/sessions/${self.id}/hand`, okSchema, {
              body: { raised: !self.handRaisedAt },
            })
              .then(refresh)
              .catch((e) => setError((e as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          {self.handRaisedAt ? 'Опустить руку' : 'Поднять руку'}
        </button>
      </div>
      {(!self.audioAllowed || !self.videoAllowed || !self.screenAllowed) && (
        <p role="status">
          Организатор ограничил:{' '}
          {[
            !self.audioAllowed && 'микрофон',
            !self.videoAllowed && 'камеру',
            !self.screenAllowed && 'демонстрацию экрана',
          ]
            .filter(Boolean)
            .join(', ')}
          . Для включения нужно разрешение.
        </p>
      )}
      <details>
        <summary>Устройства и звук</summary>
        <div className="form-grid">
          <label>
            Камера
            <select
              aria-label="Камера"
              value={camera}
              onChange={(e) => void switchDevice('videoinput', e.target.value)}
            >
              <option value="">По умолчанию</option>
              {devices
                .filter((d) => d.kind === 'videoinput' && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Камера ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Микрофон
            <select
              aria-label="Микрофон"
              value={mic}
              onChange={(e) => void switchDevice('audioinput', e.target.value)}
            >
              <option value="">По умолчанию</option>
              {devices
                .filter((d) => d.kind === 'audioinput' && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Микрофон ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
          {'setSinkId' in HTMLMediaElement.prototype && (
            <label>
              Динамики
              <select
                aria-label="Динамики"
                value={speaker}
                onChange={(e) => void switchDevice('audiooutput', e.target.value)}
              >
                <option value="">По умолчанию</option>
                {devices
                  .filter((d) => d.kind === 'audiooutput' && d.deviceId)
                  .map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Динамики ${i + 1}`}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
        <button className="secondary" onClick={() => void enumerate()}>
          Обновить список устройств
        </button>
        <p className="muted">
          Названия могут появиться после разрешения доступа. Звук экрана доступен, если браузер
          предлагает его при выборе источника.
        </p>
      </details>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
function DeviceReporter({
  id,
  sid,
  initialRevision,
}: {
  id: string;
  sid: string;
  initialRevision: number;
}) {
  const room = useRoomContext(),
    revision = useRef(initialRevision);
  revision.current = Math.max(revision.current, initialRevision);
  useEffect(() => {
    let disposed = false,
      busy = false;
    async function report() {
      if (disposed || busy || room.state !== ConnectionState.Connected) return;
      busy = true;
      const read = (source: Track.Source) => {
        const p = room.localParticipant.getTrackPublication(source);
        return p?.track && !p.isMuted
          ? { label: p.track.mediaStreamTrack.label.slice(0, 300), trackSid: p.trackSid }
          : null;
      };
      try {
        await api(`/meetings/${id}/sessions/${sid}/devices`, okSchema, {
          body: {
            revision: ++revision.current,
            camera: read(Track.Source.Camera),
            microphone: read(Track.Source.Microphone),
          },
        });
      } catch {
        /* Telemetry errors are technical, never learning results. */
      } finally {
        busy = false;
      }
    }
    const events = [
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
    ];
    for (const e of events) room.on(e, report);
    const timer = setInterval(() => void report(), 2000);
    void report();
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const e of events) room.off(e, report);
    };
  }, [room, id, sid]);
  return null;
}
function MeetingChat({ id }: { id: string }) {
  const { data, error, refresh } = usePolling(
    `/meetings/${id}/messages`,
    meetingMessagesSchema,
    2500,
  );
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [sendError, setSendError] = useState(''),
    [older, setOlder] = useState<z.infer<typeof meetingMessagesSchema>['items']>([]),
    [cursor, setCursor] = useState<
      z.infer<typeof meetingMessagesSchema>['nextCursor'] | undefined
    >();
  const pending = useRef<{ operationId: string; text: string } | null>(null);
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSendError('');
    pending.current ??= { operationId: crypto.randomUUID(), text };
    try {
      await api(`/meetings/${id}/messages`, meetingMessagesSchema, { body: pending.current });
      pending.current = null;
      setText('');
      await refresh();
    } catch (e) {
      setSendError((e as Error).message);
      if (e instanceof ApiError && e.status && e.status < 500) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    const c = cursor === undefined ? data?.nextCursor : cursor;
    if (!c) return;
    try {
      const page = await api(
        `/meetings/${id}/messages?${new URLSearchParams({ beforeCreatedAt: c.createdAt, beforeId: c.id })}`,
        meetingMessagesSchema,
      );
      setOlder((v) => [...v, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setSendError((e as Error).message);
    }
  }
  const items = [
    ...new Map([...(data?.items ?? []), ...older].map((m) => [m.id, m])).values(),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return (
    <section className="panel meeting-chat" aria-label="Чат видеовстречи">
      <h2>Чат встречи</h2>
      {error && <ErrorState error={error} retry={() => void refresh()} />}
      <div role="log" aria-live="polite">
        {items.map((m) => (
          <article key={m.id}>
            <strong>{m.name}</strong>{' '}
            <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleTimeString('ru')}</time>
            <p className="content-text">{m.text}</p>
          </article>
        ))}
        {!items.length && <p>Сообщений пока нет.</p>}
      </div>
      {(cursor === undefined ? data?.nextCursor : cursor) && (
        <button className="secondary" onClick={() => void more()}>
          Предыдущие сообщения
        </button>
      )}
      <form onSubmit={(e) => void send(e)}>
        <label>
          Сообщение в чат
          <textarea
            required
            maxLength={2000}
            value={text}
            disabled={busy || Boolean(pending.current)}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button disabled={busy || !text.trim()}>
          {busy
            ? 'Отправляем…'
            : pending.current
              ? 'Повторить отправку сообщения'
              : 'Отправить в чат'}
        </button>
      </form>
      {sendError && (
        <p role="alert" className="error">
          {sendError}
        </p>
      )}
    </section>
  );
}
