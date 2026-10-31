import { t as tr, dateLocale } from '../../i18n';
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
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
  meetingGuestSessionSchema,
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
import { api, ApiError, setMeetingCsrf } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { ErrorState, LoadingState } from '../../components/States';
import { MeetingChat } from './MeetingChat';
import {
  MeetingVideoTrack,
  RecordingProtectionNotice,
  RecordingWatermark,
} from './RecordingProtection';
import { usePolling, okSchema, meetingTime } from './shared';
const GuestRoom = createContext({ guest: false, admitted: false });
export function GuestMeetingRoomPage() {
  const { id } = useParams();
  const { state, refresh } = useResource(
    `/meeting-guests/${id}/session`,
    meetingGuestSessionSchema,
  );
  useEffect(() => {
    if (state.status === 'ready') setMeetingCsrf(id!, state.data.csrfToken);
    return () => setMeetingCsrf(id!, null);
  }, [id, state]);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <GuestRoom.Provider value={{ guest: true, admitted: state.data.admitted }}>
      <MeetingRoomPage />
    </GuestRoom.Provider>
  );
}
export function MeetingRoomPage() {
  const { id } = useParams();
  return <RoomEntry key={id} id={id!} />;
}
function RoomEntry({ id }: { id: string }) {
  const { guest, admitted: guestAdmitted } = useContext(GuestRoom);
  const { session } = useAuth();
  const { state, refresh } = useResource(`/meetings/${id}`, meetingSchema),
    [joined, setJoined] = useState<MeetingSession | null>(null),
    [vanish, setVanish] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{ operationId: string; vanish: boolean } | null>(null);
  async function enter() {
    setBusy(true);
    setError('');
    try {
      pending.current ??= { operationId: crypto.randomUUID(), vanish };
      const result = await api(`/meetings/${id}/join`, joinMeetingSchema, {
        body: pending.current,
      });
      setJoined(result.session);
      pending.current = null;
    } catch (e) {
      setError(tr((e as Error).message));
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
      {!guest && <Link to={`/meetings/${id}`}>{tr('← Карточка занятия')}</Link>}
      <h1>{m.title}</h1>
      {guest && guestAdmitted && ['completed', 'cancelled'].includes(m.status) ? (
        <>
          <p>{tr('Встреча завершена')}</p>
          <MeetingChat id={id} readOnly />
        </>
      ) : (
        <section className="panel meeting-prejoin">
          <h2>{tr('Присоединение к видеозанятию')}</h2>
          {m.recordingProtectionEnabled && <RecordingProtectionNotice />}
          <p>
            {meetingTime(m)} · {m.timeZone}
          </p>
          {!vanish && (
            <p>
              {tr(
                'Камера и микрофон при входе выключены. Вы сможете включить их и выбрать устройства в комнате.',
              )}
            </p>
          )}
          {m.lobbyEnabled && !m.canManage && (
            <p>{tr('Организатор допустит вас из зала ожидания.')}</p>
          )}
          {!guest && session.user?.role === 'superadmin' && (
            <div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={vanish}
                  disabled={busy || Boolean(pending.current) || m.status !== 'live'}
                  onChange={(e) => setVanish(e.target.checked)}
                  aria-describedby="vanish-description"
                />
                {tr('Войти в VANISH-режиме')}
              </label>
              <p id="vanish-description">
                {tr(
                  'Вы видите и слышите встречу, но не отображаетесь участникам. Камера, микрофон, демонстрация, рука и отправка сообщений недоступны. Вход сохраняется в журнале.',
                )}
              </p>
              {m.status !== 'live' && <p>{tr('VANISH доступен после начала встречи.')}</p>}
            </div>
          )}
          <button disabled={busy || !m.canJoin || !m.videoConfigured} onClick={() => void enter()}>
            {busy
              ? tr('Подключаем…')
              : pending.current
                ? tr('Повторить подключение')
                : m.canManage && m.status === 'scheduled'
                  ? tr('Начать встречу')
                  : tr('Войти во встречу')}
          </button>
          {!m.videoConfigured && (
            <p role="status">
              {tr(
                'Видеосвязь пока не подключена администратором. Расписание и учебные результаты сохранены.',
              )}
            </p>
          )}
          {!m.canJoin && <p>{tr('Вход недоступен: проверьте срок и статус занятия.')}</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </section>
      )}
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
  const { guest } = useContext(GuestRoom);
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
      <LoadingState text={tr('Проверяем допуск во встречу…')} />
    );
  const data = state.data;
  const finished = ['completed', 'cancelled'].includes(data.meeting.status);
  return (
    <>
      <div className="meeting-title">
        <div>
          {!guest && <Link to={`/meetings/${id}`}>{tr('← Карточка занятия')}</Link>}
          <h1>{data.meeting.title}</h1>
        </div>
        {!(token && admitted) && (
          <button className="secondary danger" disabled={leaving} onClick={() => void leave()}>
            {leaving ? tr('Выходим…') : tr('Покинуть встречу')}
          </button>
        )}
      </div>
      {state.error && (
        <p role="alert" className="error">
          {tr('Состояние встречи не обновлено. ')}
          {tr(state.error.message)}
        </p>
      )}
      {finished || self?.state === 'removed' || self?.state === 'left' ? (
        <section className="panel">
          <h2>
            {finished
              ? tr('Встреча завершена')
              : self?.state === 'removed'
                ? tr('Организатор удалил вас из встречи')
                : tr('Вы вышли из встречи')}
          </h2>
          {!guest && <Link to={`/meetings/${id}`}>{tr('Итоги и домашняя работа →')}</Link>}
          {finished && <MeetingChat id={id} readOnly />}
        </section>
      ) : self?.state === 'waiting' ? (
        <section className="panel" role="status">
          <h2>{tr('Зал ожидания')}</h2>
          <p>{tr('Ожидайте допуска организатора. Камера и микрофон выключены.')}</p>
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
          <Conference
            data={data}
            refresh={state.refresh}
            leave={() => void leave()}
            leaving={leaving}
          />
          <RoomAudioRenderer />
          <StartAudio label={tr('Включить звук встречи')} />
        </LiveKitRoom>
      ) : !tokenError ? (
        <LoadingState text={tr('Подключаем видеосвязь…')} />
      ) : null}
      {tokenError && <ErrorState error={tokenError} retry={() => void fetchToken()} />}{' '}
      {disconnected && admitted && (
        <p role="alert">
          {tr('Соединение разорвано.')}{' '}
          <button onClick={() => void fetchToken()}>{tr('Подключиться снова')}</button>
        </p>
      )}
    </>
  );
}
function Conference({
  data,
  refresh,
  leave,
  leaving,
}: {
  data: MeetingRoomState;
  refresh: () => Promise<void>;
  leave: () => void;
  leaving: boolean;
}) {
  const room = useRoomContext(),
    allPeers = useParticipants(),
    tracks = useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { onlySubscribed: false },
    );
  const connection = useConnectionState(),
    { session } = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [ending, setEnding] = useState(false);
  const pending = useRef<z.infer<typeof moderateMeetingSchema> | null>(null);
  const self = data.self!;
  const peers = allPeers.filter((p) => !(self.vanish && p.isLocal));
  const protectedCall = data.meeting.recordingProtectionEnabled;
  const viewer = `${room.localParticipant.name || tr('Участник')} · ${self.id.replaceAll('-', '').slice(0, 12)}`;
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
      setError(tr((e as Error).message));
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
    <div
      className={`conference${protectedCall ? ' recording-protected' : ''}`}
      data-testid="video-conference"
    >
      {protectedCall && <RecordingProtectionNotice />}
      {self.vanish && (
        <p className="inline-message" role="status" data-testid="vanish-status">
          {tr('VANISH-режим активен. Вы скрыты от участников; вход сохранён в журнале.')}
        </p>
      )}
      <p className="meeting-connection" role="status">
        {connection === ConnectionState.Connected
          ? tr('Соединение установлено')
          : connection === ConnectionState.Reconnecting ||
              connection === ConnectionState.SignalReconnecting
            ? tr('Восстанавливаем соединение…')
            : tr('Подключение…')}{' '}
        {tr('· Участников: ')}
        {peers.length}
      </p>
      {!data.available && (
        <p role="alert" className="error">
          {tr(
            'Состояние видеосервиса временно недоступно. Управление будет повторено после восстановления.',
          )}
        </p>
      )}
      {data.pendingCommands > 0 && (
        <p role="status" className="warning">
          {tr('Команд ожидает доставки: ')}
          {data.pendingCommands}
          {tr('. Не считайте отключение подтверждённым до доставки.')}
        </p>
      )}
      {!self.vanish && (
        <DeviceReporter id={data.meeting.id} sid={self.id} initialRevision={self.deviceRevision} />
      )}

      {screens.length > 0 && (
        <section className="screen-stage" aria-label={tr('Демонстрации экрана')}>
          {screens.map((t) => (
            <div key={t.participant.identity} className="screen-share">
              <p>
                {tr('Экран: ')}
                {t.participant.name}
              </p>
              {isTrackReference(t) && <MeetingVideoTrack trackRef={t} protected={protectedCall} />}
              {protectedCall && <RecordingWatermark viewer={viewer} />}
            </div>
          ))}
        </section>
      )}
      <div
        className="participant-grid"
        aria-label={tr('Участники видеовстречи')}
        data-count={peers.length}
      >
        {peers.map((p) => {
          const info = data.participants.find((x) => x.identity === p.identity),
            track = tracks.find(
              (t) => t.participant.identity === p.identity && t.source === Track.Source.Camera,
            );
          return (
            <article
              className={`participant-tile tile-tone-${peers.indexOf(p) % 6} ${pinned === p.identity ? 'pinned' : ''} ${p.isSpeaking ? 'speaking' : ''}`}
              key={p.identity}
              data-testid="meeting-participant"
              data-identity={p.identity}
            >
              <div className="participant-top">
                <strong>
                  <CallIcon name={p.isMicrophoneEnabled ? 'mic' : 'muted'} />{' '}
                  {info?.name ?? p.name ?? tr('Участник')} {p.isLocal ? tr('(вы)') : ''}
                </strong>
                {info?.handRaisedAt && (
                  <span className="raised-hand" aria-label={tr('Рука поднята')}>
                    ✋
                  </span>
                )}
                <DeviceWarnings info={info} />
              </div>
              {track &&
              isTrackReference(track) &&
              track.publication.track &&
              !track.publication.isMuted ? (
                <MeetingVideoTrack trackRef={track} protected={protectedCall} />
              ) : (
                <div className="participant-placeholder" aria-label={tr('Камера выключена')}>
                  {(info?.name ?? p.name ?? '?').slice(0, 1)}
                </div>
              )}
              {protectedCall && <RecordingWatermark viewer={viewer} />}
              <p className="participant-caption">
                {info?.role === 'organizer'
                  ? tr('Организатор')
                  : info?.role === 'superadmin'
                    ? tr('Суперадмин')
                    : info?.role === 'admin'
                      ? tr('Администратор')
                      : info?.role === 'guest'
                        ? tr('Гость')
                        : tr('Участник')}{' '}
                · {p.isMicrophoneEnabled ? tr('Микрофон включён') : tr('Микрофон выключен')}{' '}
                {p.isSpeaking ? tr('· Говорит') : ''}
              </p>
              <div className="participant-tools">
                <button
                  className="secondary"
                  onClick={() => setPinned((v) => (v === p.identity ? null : p.identity))}
                  aria-label={`${pinned === p.identity ? tr('Открепить') : tr('Закрепить')}: ${info?.name ?? p.name}`}
                >
                  <CallIcon name="pin" />
                  <span className="sr-only">
                    {pinned === p.identity ? tr('Открепить') : tr('Закрепить')}
                  </span>
                </button>
                <button
                  className="secondary"
                  onClick={(e) =>
                    void e.currentTarget
                      .closest('article')
                      ?.requestFullscreen()
                      .catch(() => setError(tr('Полноэкранный режим недоступен в этом браузере.')))
                  }
                >
                  <CallIcon name="expand" />
                  <span className="sr-only">{tr('На весь экран')}</span>
                </button>
              </div>
              {data.meeting.canManage &&
                !p.isLocal &&
                info &&
                (info.role !== 'superadmin' || session.user?.role === 'superadmin') && (
                  <details className="participant-moderation">
                    <summary>{tr('Управление участником')}</summary>
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
                        {info.audioAllowed ? tr('Отключить микрофон') : tr('Разрешить микрофон')}
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
                        {info.videoAllowed ? tr('Отключить камеру') : tr('Разрешить камеру')}
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
                        {info.screenAllowed
                          ? tr('Запретить демонстрацию')
                          : tr('Разрешить демонстрацию')}
                      </button>
                      {info.handRaisedAt && (
                        <button
                          disabled={busy}
                          onClick={() => void moderate('lower_hand', p.identity)}
                        >
                          {tr('Опустить руку участника')}
                        </button>
                      )}
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => void moderate('kick', p.identity)}
                      >
                        {tr('Удалить из встречи')}
                      </button>
                    </div>
                  </details>
                )}
            </article>
          );
        })}
      </div>
      {data.meeting.canManage && (
        <details className="conference-manage" open={data.waiting.length > 0 ? true : undefined}>
          <summary>
            {tr('Управление встречей · ')}
            {data.waiting.length}
          </summary>
          <section className="panel meeting-moderation" aria-label={tr('Управление встречей')}>
            <h2>{tr('Управление встречей')}</h2>
            <div className="button-row">
              <button disabled={busy} onClick={() => void moderate('mute_all')}>
                {tr('Отключить микрофоны учеников')}
              </button>
              <button
                disabled={busy}
                onClick={() => void moderate(data.meeting.locked ? 'unlock' : 'lock')}
              >
                {data.meeting.locked ? tr('Открыть вход') : tr('Закрыть вход')}
              </button>
              <button className="danger" disabled={busy} onClick={() => setEnding((v) => !v)}>
                {tr('Завершить встречу для всех')}
              </button>
            </div>
            {ending && (
              <div className="inline-message">
                <p>
                  {tr(
                    'Все участники будут отключены. Итог и домашние задания сохраняются в карточке занятия.',
                  )}
                </p>
                <button className="danger" disabled={busy} onClick={() => void moderate('end')}>
                  {tr('Подтвердить завершение для всех')}
                </button>
              </div>
            )}
            <h3>
              {tr('Зал ожидания · ')}
              {data.waiting.length}
            </h3>
            {data.waiting.length ? (
              <ul className="meeting-agenda">
                {data.waiting.map((p) => (
                  <li key={p.identity}>
                    <strong>{p.name}</strong>
                    <button disabled={busy} onClick={() => void moderate('admit', p.identity)}>
                      {tr('Допустить: ')}
                      {p.name}
                    </button>
                    <button
                      className="secondary danger"
                      disabled={busy}
                      onClick={() => void moderate('kick', p.identity)}
                    >
                      {tr('Отказать: ')}
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{tr('Ожидающих участников нет.')}</p>
            )}
            {data.meeting.members.some((m) => m.blocked) && (
              <details>
                <summary>{tr('Удалённые участники')}</summary>
                {data.meeting.members
                  .filter((m) => m.blocked)
                  .map((m) => (
                    <p key={m.id}>
                      {m.name}{' '}
                      <button disabled={busy} onClick={() => void moderate('restore', m.id)}>
                        {tr('Разрешить возврат: ')}
                        {m.name}
                      </button>
                    </p>
                  ))}
              </details>
            )}
          </section>
        </details>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
          {pending.current && (
            <button
              disabled={busy}
              onClick={() => void moderate(pending.current!.action, pending.current!.targetId)}
            >
              {tr('Повторить команду')}
            </button>
          )}
        </p>
      )}
      <aside className="meeting-chat-panel" hidden={!chatOpen}>
        <div className="chat-panel-title">
          <strong>{tr('Чат встречи')}</strong>
          <button
            className="secondary"
            aria-label={tr('Закрыть чат')}
            onClick={() => setChatOpen(false)}
          >
            ×
          </button>
        </div>
        <MeetingChat id={data.meeting.id} readOnly={self.vanish} />
      </aside>
      <MediaControls
        id={data.meeting.id}
        self={self}
        refresh={refresh}
        chatOpen={chatOpen}
        toggleChat={() => setChatOpen((v) => !v)}
        leave={leave}
        leaving={leaving}
      />
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
                ? tr('Возможно, виртуальная камера')
                : tr('Возможно, виртуальный микрофон')
            }
            aria-label={
              w.kind === 'camera'
                ? tr('Предупреждение о виртуальной камере')
                : tr('Предупреждение о виртуальном микрофоне')
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
                {tr('Возможно, участник использует')}{' '}
                {w.kind === 'camera' ? tr('виртуальную камеру') : tr('виртуальный микрофон')} — «
                {w.label}».
              </strong>
              <p>
                {tr('Совпадение: ')}
                {w.match}
                {tr(
                  '. Название сообщено браузером и может быть изменено. Это не доказательство нарушения.',
                )}
              </p>
              <small>
                {tr('Доступно организаторам и суперадмину ·')}{' '}
                {new Date(w.reportedAt).toLocaleTimeString(dateLocale)}
              </small>
              <button className="secondary" onClick={() => setOpened(null)}>
                {tr('Закрыть сведения')}
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
  chatOpen,
  toggleChat,
  leave,
  leaving,
}: {
  id: string;
  self: MeetingSession;
  refresh: () => Promise<void>;
  chatOpen: boolean;
  toggleChat: () => void;
  leave: () => void;
  leaving: boolean;
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
      setError(tr('Список устройств недоступен. Проверьте разрешения браузера.'));
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
          ? tr(
              'Демонстрация не началась. Выберите экран или окно; при отказе разрешения можно повторить.',
            )
          : tr(
              'Не удалось включить устройство. Проверьте разрешения камеры/микрофона и повторите. Учебная оценка не меняется.',
            ),
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
      setError(tr('Не удалось переключить устройство. Попробуйте другое.'));
    }
  }
  return (
    <section className="meeting-controls" aria-label={tr('Камера, звук и демонстрация')}>
      <div className="button-row">
        <button
          aria-pressed={isMicrophoneEnabled}
          disabled={busy || !self.audioAllowed}
          onClick={() => void act('audio')}
        >
          <CallIcon name={isMicrophoneEnabled ? 'mic' : 'muted'} />
          <span>{isMicrophoneEnabled ? tr('Выключить микрофон') : tr('Включить микрофон')}</span>
        </button>
        <button
          aria-pressed={isCameraEnabled}
          disabled={busy || !self.videoAllowed}
          onClick={() => void act('video')}
        >
          <CallIcon name={isCameraEnabled ? 'camera' : 'camera-off'} />
          <span>{isCameraEnabled ? tr('Выключить камеру') : tr('Включить камеру')}</span>
        </button>
        <button
          aria-pressed={isScreenShareEnabled}
          disabled={busy || !self.screenAllowed}
          onClick={() => void act('screen')}
        >
          <CallIcon name="screen" />
          <span>
            {isScreenShareEnabled ? tr('Остановить демонстрацию') : tr('Демонстрация экрана')}
          </span>
        </button>
        <button
          className="secondary"
          aria-pressed={Boolean(self.handRaisedAt)}
          disabled={busy || self.vanish}
          onClick={() => {
            setBusy(true);
            void api(`/meetings/${id}/sessions/${self.id}/hand`, okSchema, {
              body: { raised: !self.handRaisedAt },
            })
              .then(refresh)
              .catch((e) => setError(tr((e as Error).message)))
              .finally(() => setBusy(false));
          }}
        >
          <CallIcon name="hand" />
          <span>{self.handRaisedAt ? tr('Опустить руку') : tr('Поднять руку')}</span>
        </button>
        <button className="secondary" aria-pressed={chatOpen} onClick={toggleChat}>
          <CallIcon name="chat" />
          <span>{tr('Чат')}</span>
        </button>
        <button className="danger leave-call" disabled={leaving} onClick={leave}>
          <CallIcon name="leave" />
          <span>{leaving ? tr('Выходим…') : tr('Покинуть встречу')}</span>
        </button>
      </div>
      {!self.vanish && (!self.audioAllowed || !self.videoAllowed || !self.screenAllowed) && (
        <p role="status">
          {tr('Организатор ограничил:')}{' '}
          {[
            !self.audioAllowed && tr('микрофон'),
            !self.videoAllowed && tr('камеру'),
            !self.screenAllowed && tr('демонстрацию экрана'),
          ]
            .filter(Boolean)
            .join(', ')}
          {tr('. Для включения нужно разрешение.')}
        </p>
      )}
      <details className="call-device-settings">
        <summary>{tr('Устройства и звук')}</summary>
        <div className="form-grid">
          <label>
            {tr('Камера')}
            <select
              aria-label={tr('Камера')}
              value={camera}
              onChange={(e) => void switchDevice('videoinput', e.target.value)}
            >
              <option value="">{tr('По умолчанию')}</option>
              {devices
                .filter((d) => d.kind === 'videoinput' && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || tr('Камера {0}', [i + 1])}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {tr('Микрофон')}
            <select
              aria-label={tr('Микрофон')}
              value={mic}
              onChange={(e) => void switchDevice('audioinput', e.target.value)}
            >
              <option value="">{tr('По умолчанию')}</option>
              {devices
                .filter((d) => d.kind === 'audioinput' && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || tr('Микрофон {0}', [i + 1])}
                  </option>
                ))}
            </select>
          </label>
          {'setSinkId' in HTMLMediaElement.prototype && (
            <label>
              {tr('Динамики')}
              <select
                aria-label={tr('Динамики')}
                value={speaker}
                onChange={(e) => void switchDevice('audiooutput', e.target.value)}
              >
                <option value="">{tr('По умолчанию')}</option>
                {devices
                  .filter((d) => d.kind === 'audiooutput' && d.deviceId)
                  .map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || tr('Динамики {0}', [i + 1])}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
        <button className="secondary" onClick={() => void enumerate()}>
          {tr('Обновить список устройств')}
        </button>
        <p className="muted">
          {tr(
            'Названия могут появиться после разрешения доступа. Звук экрана доступен, если браузер предлагает его при выборе источника.',
          )}
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
function CallIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    muted: 'M9 5a3 3 0 0 1 6 0v7M5 10v2a7 7 0 0 0 12 5M12 19v3M8 22h8M3 3l18 18',
    camera: 'M3 5h12v14H3ZM15 10l6-4v12l-6-4',
    'camera-off': 'M3 5h12v14H3ZM15 10l6-4v12l-6-4M2 2l20 20',
    screen: 'M2 3h20v14H2ZM8 21h8M12 17v4M8 10l4-4 4 4M12 6v8',
    hand: 'M7 12V5a2 2 0 0 1 4 0v7-9a2 2 0 0 1 4 0v9-7a2 2 0 0 1 4 0v9-4a2 2 0 0 1 4 0v6a7 7 0 0 1-13 4L3 13a2 2 0 0 1 3-2Z',
    chat: 'M3 3h18v14H9l-6 4Z',
    leave: 'M3 15v-4c5-5 13-5 18 0v4l-5-1v-3H8v3Z',
    pin: 'm8 3 8 0-1 6 4 4v2H5v-2l4-4ZM12 15v7',
    expand: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.camera} />
    </svg>
  );
}
