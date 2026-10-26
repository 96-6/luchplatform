import { t as tr, dateLocale } from '../../i18n';
import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from 'react';
import { meetingMessagesSchema, meetingFilePolicySchema, meetingFileSchema } from '@luch/contracts';
import type { z } from 'zod';
import { api, ApiError, uploadMeetingFile } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { ErrorState } from '../../components/States';
import { usePolling } from './shared';
type Upload = {
  key: string;
  file: File;
  progress: number;
  data: z.infer<typeof meetingFileSchema> | null;
  error: string;
};
export function MeetingChat({ id, readOnly = false }: { id: string; readOnly?: boolean }) {
  const { data, error, refresh } = usePolling(
      `/meetings/${id}/messages`,
      meetingMessagesSchema,
      2500,
    ),
    policy = useResource(`/meetings/${id}/file-policy`, meetingFilePolicySchema);
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [sendError, setSendError] = useState(''),
    [older, setOlder] = useState<z.infer<typeof meetingMessagesSchema>['items']>([]),
    [cursor, setCursor] = useState<
      z.infer<typeof meetingMessagesSchema>['nextCursor'] | undefined
    >(),
    [uploads, setUploads] = useState<Upload[]>([]),
    [uploading, setUploading] = useState(false);
  const controller = useRef<AbortController | null>(null),
    cancelQueue = useRef(false),
    pending = useRef<{ operationId: string; text: string; attachmentIds: string[] } | null>(null);
  useEffect(
    () => () => {
      cancelQueue.current = true;
      controller.current?.abort();
    },
    [],
  );
  const changeUpload = (key: string, change: Partial<Upload>) =>
    setUploads((current) => current.map((u) => (u.key === key ? { ...u, ...change } : u)));
  async function upload(item: Upload) {
    setUploading(true);
    changeUpload(item.key, { error: '', progress: 0 });
    controller.current = new AbortController();
    try {
      const value = await uploadMeetingFile(
        `/meetings/${id}/files/${item.key}`,
        item.file,
        controller.current.signal,
        (progress) => changeUpload(item.key, { progress }),
      );
      changeUpload(item.key, { data: value, progress: 100 });
    } catch (f) {
      changeUpload(item.key, { error: tr((f as Error).message) });
      policy.refresh();
    } finally {
      controller.current = null;
      setUploading(false);
    }
  }
  async function select(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    setSendError('');
    if (policy.state.status !== 'ready') return;
    if (files.length + uploads.length > 5) {
      setSendError(tr('К сообщению можно добавить не более пяти файлов.'));
      return;
    }
    const max = policy.state.data.maxFileMb * 1024 * 1024;
    if (files.some((f) => f.size < 1 || f.size > max)) {
      setSendError(tr('Выберите непустые файлы не больше {0} МБ.', [policy.state.data.maxFileMb]));
      return;
    }
    const added = files.map((file) => ({
      key: crypto.randomUUID(),
      file,
      progress: 0,
      data: null,
      error: '',
    }));
    setUploads((v) => [...v, ...added]);
    cancelQueue.current = false;
    for (const item of added) {
      if (cancelQueue.current) {
        changeUpload(item.key, { error: tr('Загрузка файла отменена.') });
        continue;
      }
      await upload(item);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSendError('');
    pending.current ??= {
      operationId: crypto.randomUUID(),
      text,
      attachmentIds: uploads.flatMap((u) => (u.data ? [u.data.id] : [])),
    };
    try {
      await api(`/meetings/${id}/messages`, meetingMessagesSchema, { body: pending.current });
      pending.current = null;
      setText('');
      setUploads([]);
      await refresh();
    } catch (f) {
      setSendError(tr((f as Error).message));
      if (f instanceof ApiError && f.status && f.status < 500) pending.current = null;
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
    } catch (f) {
      setSendError(tr((f as Error).message));
    }
  }
  const items = [
    ...new Map([...(data?.items ?? []), ...older].map((m) => [m.id, m])).values(),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const ready = uploads.every((u) => u.data) && !uploading,
    hasContent = text.trim().length > 0 || uploads.some((u) => u.data);
  return (
    <section className="panel meeting-chat" aria-label={tr('Чат видеовстречи')}>
      <h2>{tr('Чат встречи')}</h2>
      {error && <ErrorState error={error} retry={() => void refresh()} />}
      <div role="log" aria-live="polite">
        {items.map((m) => (
          <article key={m.id}>
            <strong>{m.name}</strong>{' '}
            <time dateTime={m.createdAt}>
              {new Date(m.createdAt).toLocaleTimeString(dateLocale)}
            </time>
            {m.text && <p className="content-text">{m.text}</p>}
            {m.attachments.map((f) => (
              <div className="meeting-attachment" key={f.id}>
                {f.deleted ? (
                  <p>
                    {f.filename} · {tr('Срок хранения файла истёк.')}
                  </p>
                ) : (
                  <>
                    <a href={f.url} download={f.filename}>
                      {f.mediaType.startsWith('image/') && (
                        <img src={f.url} alt={f.filename} loading="lazy" />
                      )}
                      <span>{f.filename}</span>
                    </a>
                    <small>
                      {(f.sizeBytes / 1024 / 1024).toLocaleString(dateLocale, {
                        maximumFractionDigits: 2,
                      })}{' '}
                      {tr('МБ')}
                      {f.expiresAt
                        ? ' · ' +
                          tr('Будет удалён {0}', [new Date(f.expiresAt).toLocaleString(dateLocale)])
                        : ''}
                    </small>
                  </>
                )}
              </div>
            ))}
          </article>
        ))}
        {!items.length && <p>{tr('Сообщений пока нет.')}</p>}
      </div>
      {(cursor === undefined ? data?.nextCursor : cursor) && (
        <button className="secondary" onClick={() => void more()}>
          {tr('Предыдущие сообщения')}
        </button>
      )}
      {!readOnly && (
        <form onSubmit={(e) => void send(e)}>
          <label>
            {tr('Сообщение в чат')}
            <textarea
              maxLength={2000}
              value={text}
              disabled={busy || Boolean(pending.current)}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label className="meeting-file-picker">
            {tr('Добавить файлы или изображения')}
            <input
              type="file"
              multiple
              aria-label={tr('Файлы и изображения для чата')}
              disabled={
                busy ||
                uploading ||
                uploads.length >= 5 ||
                Boolean(pending.current) ||
                policy.state.status !== 'ready'
              }
              onChange={(e) => void select(e)}
            />
          </label>
          {policy.state.status === 'ready' && (
            <p className="muted">
              {tr('До {0} МБ на файл. Файлы больше {1} МБ удаляются через {2} дней.', [
                policy.state.data.maxFileMb,
                policy.state.data.largeFileMb,
                policy.state.data.retentionDays,
              ])}
            </p>
          )}
          {policy.state.status === 'error' && (
            <ErrorState error={policy.state.error} retry={policy.refresh} />
          )}
          <ul className="meeting-upload-list">
            {uploads.map((u) => (
              <li key={u.key}>
                <span>{u.file.name}</span>
                <span role="status">
                  {u.data ? tr('Файл загружен') : u.error ? '' : tr('Загрузка: {0}%', [u.progress])}
                </span>
                {u.data?.expiresAt && (
                  <small>
                    {tr('Будет удалён {0}', [
                      new Date(u.data.expiresAt).toLocaleString(dateLocale),
                    ])}
                  </small>
                )}
                {u.error && (
                  <>
                    <p role="alert" className="error">
                      {u.error}
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={uploading || busy}
                      onClick={() => void upload(u)}
                    >
                      {tr('Повторить загрузку')}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || uploading || Boolean(pending.current)}
                  onClick={() => setUploads((v) => v.filter((x) => x.key !== u.key))}
                >
                  {tr('Убрать файл')}
                </button>
              </li>
            ))}
          </ul>
          {uploading && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                cancelQueue.current = true;
                controller.current?.abort();
              }}
            >
              {tr('Отменить загрузку')}
            </button>
          )}
          <button disabled={busy || !hasContent || !ready}>
            {busy
              ? tr('Отправляем…')
              : pending.current
                ? tr('Повторить отправку сообщения')
                : tr('Отправить в чат')}
          </button>
        </form>
      )}
      {sendError && (
        <p role="alert" className="error">
          {sendError}
        </p>
      )}
    </section>
  );
}
