import { t, dateLocale } from '../i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  assistantChatSchema,
  assistantVideoSchema,
  type RunView,
  type AssistantAction,
  type sendAssistantMessageSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import { api, ApiError } from '../lib/api';
import { AssistantReplyAudio } from './AssistantReplyAudio';
import { ErrorState } from './States';
type Chat = z.infer<typeof assistantChatSchema>;
type Pending = z.infer<typeof sendAssistantMessageSchema>;

export function AssistantChat({
  view,
  editable,
  refresh,
}: {
  view: RunView;
  editable: boolean;
  refresh: () => Promise<void>;
}) {
  const [chat, setChat] = useState<Chat | null>(null),
    [text, setText] = useState(''),
    [action, setAction] = useState<AssistantAction>('dialogue'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const pending = useRef<Pending | null>(null),
    mounted = useRef(true);
  const base = `/assistant/runs/${view.run.id}/messages`;
  useEffect(() => {
    mounted.current = true;
    const c = new AbortController();
    void api(base, assistantChatSchema, { signal: c.signal })
      .then(setChat)
      .catch((e) => {
        if (!c.signal.aborted) setError(e as Error);
      });
    return () => {
      mounted.current = false;
      c.abort();
    };
  }, [base, view.attempts.length]);
  async function send(kind: AssistantAction) {
    if (!view.current || busy) return;
    const request = pending.current ?? {
      operationId: crypto.randomUUID(),
      turnId: view.current.turn.id,
      action: kind,
      text,
    };
    pending.current = request;
    setBusy(true);
    setError(null);
    try {
      const result = await api(base, assistantChatSchema, { body: request });
      pending.current = null;
      if (mounted.current) {
        setChat(result);
        setText('');
        await refresh();
      }
    } catch (e) {
      if (mounted.current) {
        setError(e as Error);
        if (e instanceof ApiError && e.code === 'TURN_CHANGED') {
          pending.current = null;
          await refresh();
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function older() {
    if (!chat?.nextBefore) return;
    setBusy(true);
    try {
      const page = await api(`${base}?before=${chat.nextBefore}`, assistantChatSchema);
      setChat({
        ...chat,
        messages: [...page.messages, ...chat.messages],
        nextBefore: page.nextBefore,
      });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void send(action);
  }
  const allowed = chat?.hintsEnabled ?? view.run.purpose === 'practice';
  return (
    <section className="panel assistant-chat" aria-label={t('Чат с помощником')}>
      <div className="section-heading">
        <h2>{t('Демо-помощник')}</h2>
        <Link to={`/assistant?userId=${view.run.user.id}`}>{t('Выбрать персонажа →')}</Link>
      </div>
      <p className="muted">
        {t(
          'Сценарный помощник работает по текущему заданию. Использованная помощь учитывается в попытке.',
        )}
      </p>
      {!allowed && (
        <p className="notice">
          {t(
            'В диагностике и контроле доступны только общие инструкции. Подсказки и тематический диалог отключены.',
          )}
        </p>
      )}
      {chat?.nextBefore && (
        <button className="secondary" disabled={busy} onClick={() => void older()}>
          {t('Показать предыдущие сообщения')}
        </button>
      )}
      <ol className="chat-messages" role="log" aria-live="polite" aria-relevant="additions">
        {chat?.messages.map((m) => (
          <li className={`chat-message ${m.role}`} key={`${m.role}-${m.id}`}>
            <div className="chat-author">
              {m.role === 'assistant' ? (
                <>
                  <img src={`/avatars/${m.avatarId}.svg`} alt="" width="36" height="36" />
                  {t('Демо-помощник')}
                </>
              ) : (
                t('Пользователь')
              )}
              <time dateTime={m.createdAt}>
                {new Date(m.createdAt).toLocaleTimeString(dateLocale, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
            <p className="content-text">{m.content}</p>
            {m.context && (
              <details>
                <summary>{t('Сохранённый контекст этой реплики')}</summary>
                <pre className="engine-debug">{JSON.stringify(m.context, null, 2)}</pre>
              </details>
            )}
            {m.role === 'assistant' && (
              <AssistantReplyAudio
                messageId={m.id}
                editable={editable && Boolean(chat?.writable)}
              />
            )}
            {m.role === 'assistant' && (
              <AssistantVideo messageId={m.id} editable={editable && Boolean(chat.writable)} />
            )}
          </li>
        ))}
      </ol>
      {chat && !chat.messages.length && (
        <p>{t('Объяснить задание, дать подсказку или начать короткий диалог?')}</p>
      )}
      {busy && <p role="status">{t('Помощник готовит ответ…')}</p>}
      {error && (
        <ErrorState
          error={error}
          retry={() => {
            if (pending.current) void send(pending.current.action);
            else void api(base, assistantChatSchema).then(setChat).catch(setError);
          }}
        />
      )}
      {editable && view.current && (
        <>
          <div className="form-actions">
            <button
              disabled={busy || Boolean(pending.current)}
              onClick={() => void send('explain')}
            >
              {t('Объяснить задание')}
            </button>
            <button
              className="secondary"
              disabled={busy || !allowed || Boolean(pending.current)}
              onClick={() => void send('hint')}
            >
              {t('Подсказка помощника')}
            </button>
            <button
              className="secondary"
              disabled={busy || !allowed || Boolean(pending.current)}
              onClick={() => void send('dialogue')}
            >
              {t('Диалог по теме')}
            </button>
          </div>
          <form onSubmit={submit}>
            <fieldset disabled={busy || !allowed || Boolean(pending.current)}>
              <label htmlFor={`assistant-action-${view.run.id}`}>{t('Тип сообщения')}</label>
              <select
                id={`assistant-action-${view.run.id}`}
                value={action}
                onChange={(e) => setAction(e.target.value as AssistantAction)}
              >
                <option value="dialogue">{t('Диалог по теме')}</option>
                <option value="explain">{t('Объяснение')}</option>
                <option value="hint">{t('Подсказка')}</option>
              </select>
              <label htmlFor={`assistant-text-${view.run.id}`}>{t('Ваше сообщение')}</label>
              <textarea
                id={`assistant-text-${view.run.id}`}
                maxLength={1000}
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('Короткий вопрос или реплика по теме урока')}
              />
              <button>{t('Отправить помощнику')}</button>
            </fieldset>
          </form>
          {pending.current && !busy && (
            <button
              className="secondary"
              onClick={() => {
                pending.current = null;
                setError(null);
                setText((t) => t);
              }}
            >
              {t('Отменить повтор сообщения')}
            </button>
          )}
        </>
      )}
      {chat?.context && (
        <details>
          <summary>{t('Контекст помощника для суперадмина')}</summary>
          <pre className="engine-debug">{JSON.stringify(chat.context, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
function AssistantVideo({ messageId, editable }: { messageId: string; editable: boolean }) {
  const [video, setVideo] = useState<z.infer<typeof assistantVideoSchema> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const base = `/assistant/messages/${messageId}/video`;
  useEffect(() => {
    const c = new AbortController();
    void api(`${base}/status`, assistantVideoSchema, { body: {}, signal: c.signal })
      .then(setVideo)
      .catch((e) => {
        if (!c.signal.aborted && !(e instanceof ApiError && e.status === 404)) setError(e as Error);
      });
    return () => c.abort();
  }, [base]);
  useEffect(() => {
    if (video?.status !== 'pending') return;
    const controller = new AbortController(),
      timer = setTimeout(() => {
        void api(`${base}/status`, assistantVideoSchema, { body: {}, signal: controller.signal })
          .then(setVideo)
          .catch((e) => {
            if (!controller.signal.aborted) setError(e as Error);
          });
      }, 5000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [video, base]);
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      setVideo(await api(`${base}/prepare`, assistantVideoSchema, { body: {} }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  if (video?.status === 'ready' && video.url)
    return (
      <div className="assistant-video">
        <p className="muted">
          {t('Видеоаватар · HeyGen ')}
          {video.cached ? t('· сохранённый ролик') : ''}
        </p>
        <video
          controls
          preload="metadata"
          src={video.url}
          aria-label={t('Видео-реплика помощника')}
        />
        <p className="muted">{t('Текст реплики доступен выше.')}</p>
      </div>
    );
  return (
    <div>
      {video?.status === 'pending' ? (
        <p role="status">{t('HeyGen готовит видео… Текст уже доступен.')}</p>
      ) : (
        editable && (
          <button className="secondary" disabled={busy} onClick={() => void prepare()}>
            {busy ? t('Запускаем видео…') : t('Видео с аватаром')}
          </button>
        )
      )}
      {video?.message && (
        <p role={video.status === 'error' ? 'alert' : 'status'}>{t(video.message)}</p>
      )}
      {error && (
        <p className="error" role="alert">
          {t(error.message)}
        </p>
      )}
    </div>
  );
}
