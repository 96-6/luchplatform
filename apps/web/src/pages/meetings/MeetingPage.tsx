import { MeetingChat } from './MeetingChat';
import { MeetingInvitePanel } from './MeetingExtras';
import { t, dateLocale } from '../../i18n';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  meetingSchema,
  plansPageSchema,
  teacherExerciseBankSchema,
  type Meeting,
  type meetingSummarySchema,
} from '@luch/contracts';
import type { z } from 'zod';
import { useAuth } from '../../auth/AuthContext';
import { api, ApiError } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { LoadingState, ErrorState } from '../../components/States';
import { MeetingEditor } from './SchedulePage';
import { statusLabels, meetingTime, browserZone, zonedDate } from './shared';
export function MeetingPage() {
  const { id } = useParams();
  return <MeetingDetail key={id} id={id!} />;
}
function MeetingDetail({ id }: { id: string }) {
  const { session } = useAuth(),
    { state, refresh } = useResource(`/meetings/${id}`, meetingSchema, true),
    [editing, setEditing] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const op = useRef<string | null>(null);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const m = state.data;
  async function cancel() {
    setBusy(true);
    setError('');
    try {
      op.current ??= crypto.randomUUID();
      await api(`/meetings/${id}/moderate`, meetingSchema, {
        body: { operationId: op.current, action: 'cancel', revision: m.revision },
      });
      op.current = null;
      refresh();
    } catch (e) {
      setError(t((e as Error).message));
      if (e instanceof ApiError && e.status && e.status < 500) {
        op.current = null;
        refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link to="/schedule">{t('← Расписание')}</Link>
      <p className="eyebrow">
        {m.language === 'ru' ? t('РКИ') : t('Английский')} · {statusLabels[m.status]}
      </p>
      <h1>{m.title}</h1>
      <p>
        {meetingTime(m)} —{' '}
        {m.endsAt
          ? new Intl.DateTimeFormat(dateLocale, {
              timeZone: m.timeZone,
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(m.endsAt))
          : t('Без ограничения длительности')}{' '}
        · {m.timeZone}
      </p>
      {m.timeZone !== browserZone() && (
        <p className="muted">
          {t('У вас: ')}
          {meetingTime(m, browserZone())} · {browserZone()}
        </p>
      )}
      <p className="content-text">{m.description}</p>
      <p>
        {t('Преподаватель: ')}
        <strong>{m.organizer.name}</strong>
      </p>
      <section className="panel">
        <h2>{t('Участники')}</h2>
        <ul>
          {m.members.map((p) => (
            <li key={p.id}>
              {p.name} {p.role === 'organizer' ? t('· организатор') : ''}{' '}
              {p.blocked ? t('· вход закрыт организатором') : ''}
            </li>
          ))}
        </ul>
        <p>
          {m.lobbyEnabled
            ? t('Ученики входят после допуска организатора.')
            : t('Ученики входят после начала встречи.')}{' '}
          {m.locked ? t('Новые подключения закрыты.') : ''}
        </p>
        {['scheduled', 'live'].includes(m.status) && (
          <>
            <Link className="button" to={`/meetings/${id}/room`}>
              {m.canManage && m.status === 'scheduled'
                ? t('Начать видеозанятие')
                : t('Открыть видеовстречу')}
            </Link>
            {!m.videoConfigured && (
              <p>{t('Видеосвязь пока не подключена администратором. Расписание сохранено.')}</p>
            )}
            {!m.canJoin && (
              <p>
                {t('Вход откроется за 15 минут до начала, если организатор не закрыл встречу.')}
              </p>
            )}
          </>
        )}
        {m.canManage && m.status === 'scheduled' && (
          <div className="button-row">
            {m.kind === 'scheduled' && (
              <button className="secondary" onClick={() => setEditing((v) => !v)}>
                {t('Изменить расписание')}
              </button>
            )}
            <button className="secondary danger" disabled={busy} onClick={() => void cancel()}>
              {busy ? t('Отменяем…') : op.current ? t('Повторить отмену') : t('Отменить занятие')}
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
      {m.kind === 'adhoc' && m.canManage && <MeetingInvitePanel meeting={m} />}
      <MeetingChat id={id} readOnly />
      {editing && (
        <MeetingEditor
          key={m.revision}
          meeting={m}
          zone={m.timeZone}
          done={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      <section className="panel">
        <h2>{t('Итоги и домашняя работа')}</h2>
        {m.summaryComment ? (
          <p className="content-text">{m.summaryComment}</p>
        ) : (
          <p>{t('Преподаватель сохранит итог после завершения занятия.')}</p>
        )}
        {m.homework.length > 0 && (
          <ul className="meeting-agenda">
            {m.homework.map((h) => (
              <li key={h.id}>
                <strong>
                  {h.studentName}: {h.title}
                </strong>
                <p>{h.reason}</p>
                <Link to={`/plan/${h.planId}#assignment-${h.assignmentId}`}>
                  {t('Открыть домашнее задание в плане →')}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {m.summaryHistory.length > 1 && (
          <details>
            <summary>{t('История итоговых комментариев')}</summary>
            {m.summaryHistory.map((h) => (
              <article key={h.id}>
                <p>
                  {h.author} · {new Date(h.createdAt).toLocaleString(dateLocale)}
                </p>
                <p className="content-text">{h.comment}</p>
              </article>
            ))}
          </details>
        )}
      </section>
      {m.canManage && m.status === 'completed' && session.user!.role !== 'admin' && (
        <SummaryEditor key={m.summaryRevision} meeting={m} saved={refresh} />
      )}
    </>
  );
}
type Homework = z.infer<typeof meetingSummarySchema>['homework'][number];
function SummaryEditor({ meeting: m, saved }: { meeting: Meeting; saved: () => void }) {
  const [comment, setComment] = useState(m.summaryComment ?? ''),
    [homework, setHomework] = useState<Record<string, Homework>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<z.infer<typeof meetingSummarySchema> | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = pending.current ?? {
      operationId: crypto.randomUUID(),
      revision: m.summaryRevision,
      comment,
      homework: Object.values(homework),
    };
    pending.current = body;
    try {
      await api(`/meetings/${m.id}/summary`, meetingSchema, { body });
      pending.current = null;
      saved();
    } catch (e) {
      setError(t((e as Error).message));
      if (e instanceof ApiError && e.status && e.status < 500) {
        pending.current = null;
        if (e.code === 'MEETING_SUMMARY_CHANGED') saved();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label={t('Итог преподавателя')}>
      <h2>{t('Сохранить итог занятия')}</h2>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy || Boolean(pending.current)}>
          <label>
            {t('Итоговый комментарий')}
            <textarea
              aria-label={t('Итоговый комментарий')}
              required
              maxLength={3000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <h3>{t('Домашняя работа участникам')}</h3>
          <p>
            {t(
              'Задание попадёт в существующий план ученика. Первоначальная диагностика должна быть завершена.',
            )}
          </p>
          {m.members
            .filter((p) => p.role === 'student')
            .map((p) => (
              <HomeworkRow
                key={p.id}
                studentId={p.id}
                name={p.name}
                language={m.language}
                change={(h) =>
                  setHomework((v) => {
                    const next = { ...v };
                    if (h) next[p.id] = h;
                    else delete next[p.id];
                    return next;
                  })
                }
              />
            ))}
        </fieldset>
        <button disabled={busy || !comment.trim()}>
          {busy
            ? t('Сохраняем итог…')
            : pending.current
              ? t('Повторить сохранение итога')
              : t('Сохранить итог и назначения')}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
function HomeworkRow({
  studentId,
  name,
  language,
  change,
}: {
  studentId: string;
  name: string;
  language: string;
  change: (h: Homework | null) => void;
}) {
  const { state, refresh } = useResource(
    `/plans?userId=${studentId}&language=${language}&limit=10`,
    plansPageSchema,
  );
  const [enabled, setEnabled] = useState(false),
    [planId, setPlanId] = useState('');
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <div className="homework-row">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!state.data.items.length}
          onChange={(e) => {
            setEnabled(e.target.checked);
            if (!e.target.checked) change(null);
          }}
        />
        {t('Назначить домашнюю работу: ')}
        {name}
      </label>
      {!state.data.items.length && <p>{t('Сохранённого плана этого языка пока нет.')}</p>}
      {enabled && (
        <>
          <label>
            {t('План ученика')}
            <select
              aria-label={t('План ученика')}
              value={planId || state.data.items[0]?.id}
              onChange={(e) => {
                setPlanId(e.target.value);
                change(null);
              }}
            >
              {state.data.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {new Date(p.createdAt).toLocaleDateString(dateLocale)}
                </option>
              ))}
            </select>
          </label>
          <HomeworkExercise
            key={planId || state.data.items[0]!.id}
            studentId={studentId}
            planId={planId || state.data.items[0]!.id}
            change={change}
          />
        </>
      )}
    </div>
  );
}
function HomeworkExercise({
  studentId,
  planId,
  change,
}: {
  studentId: string;
  planId: string;
  change: (h: Homework | null) => void;
}) {
  const { state, refresh } = useResource(
    `/plans/${planId}/exercise-bank`,
    teacherExerciseBankSchema,
  );
  const [exercise, setExercise] = useState(''),
    [reason, setReason] = useState(t('Закрепляем материал видеозанятия.')),
    [due, setDue] = useState('');
  function update(id: string, text: string, date: string) {
    setExercise(id);
    setReason(text);
    setDue(date);
    try {
      change(
        id && text.trim()
          ? {
              studentId,
              planId,
              exerciseId: id,
              reason: text,
              dueAt: date ? zonedDate(date, browserZone()) : null,
            }
          : null,
      );
    } catch {
      change(null);
    }
  }
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <div className="form-grid">
      <label>
        {t('Упражнение для домашней работы')}
        <select
          aria-label={t('Упражнение для домашней работы')}
          required
          value={exercise}
          onChange={(e) => update(e.target.value, reason, due)}
        >
          <option value="">{t('Выберите упражнение')}</option>
          {state.data.items.map((e) => (
            <option key={e.id} value={e.id}>
              {e.lessonTitle} · {e.instruction}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('Причина домашнего задания')}
        <textarea
          aria-label={t('Причина домашнего задания')}
          required
          maxLength={2700}
          value={reason}
          onChange={(e) => update(exercise, e.target.value, due)}
        />
      </label>
      <label>
        {t('Доступно с даты')}
        <input
          type="datetime-local"
          value={due}
          onChange={(e) => update(exercise, reason, e.target.value)}
        />
      </label>
    </div>
  );
}
