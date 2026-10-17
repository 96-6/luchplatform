import { t } from '../i18n';
import { useRef, useState, type FormEvent } from 'react';
import {
  teacherExerciseBankSchema,
  planViewSchema,
  type PlanView,
  type teacherAssignmentSchema,
  type teacherAssignmentUpdateSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import { useResource } from '../lib/useResource';
import { api, ApiError } from '../lib/api';
import { LoadingState, ErrorState } from './States';
const date = (s: string) => (s ? new Date(s).toISOString() : null);
export function TeacherAssignExercise({ plan, changed }: { plan: PlanView; changed: () => void }) {
  const { state, refresh } = useResource(
    `/plans/${plan.plan.id}/exercise-bank`,
    teacherExerciseBankSchema,
  );
  const [exerciseId, setExerciseId] = useState(''),
    [due, setDue] = useState(''),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false);
  const pending = useRef<z.infer<typeof teacherAssignmentSchema> | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setDone(false);
    const body = pending.current ?? {
      operationId: crypto.randomUUID(),
      exerciseId,
      dueAt: date(due),
      reason,
      estimatedMinutes: 3,
    };
    pending.current = body;
    try {
      await api(`/teacher/plans/${plan.plan.id}/assignments`, planViewSchema, { body });
      pending.current = null;
      setReason('');
      setExerciseId('');
      setDone(true);
      changed();
    } catch (e) {
      setError(t((e as Error).message));
      if (e instanceof ApiError && e.status && e.status < 500) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label={t('Назначение преподавателя')}>
      <h2>{t('Назначить упражнение')}</h2>
      <p>
        {t(
          'Выберите задание из закреплённого маршрута. Ученик получит его в своём плане с указанной причиной.',
        )}
      </p>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy || Boolean(pending.current)}>
            <label htmlFor="teacher-exercise">{t('Упражнение для ученика')}</label>
            <select
              id="teacher-exercise"
              required
              value={exerciseId}
              onChange={(e) => setExerciseId(e.target.value)}
            >
              <option value="">{t('Выберите упражнение')}</option>
              {state.data.items.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.lessonTitle} · {e.purpose === 'control' ? t('Контроль') : t('Тренировка')} ·{' '}
                  {e.instruction}
                </option>
              ))}
            </select>
            <label htmlFor="teacher-due">{t('Открыть задание с даты')}</label>
            <input
              id="teacher-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <p className="muted">{t('Время вашего устройства. Пустая дата — доступно сразу.')}</p>
            <label htmlFor="teacher-reason">{t('Причина назначения')}</label>
            <textarea
              id="teacher-reason"
              rows={3}
              maxLength={3000}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </fieldset>
          <button disabled={busy || !exerciseId || !reason.trim()}>
            {busy
              ? t('Сохраняем назначение…')
              : pending.current
                ? t('Повторить назначение')
                : t('Назначить ученику')}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && <p role="status">{t('Упражнение назначено. Оно доступно ученику в плане.')}</p>}
    </section>
  );
}
export function TeacherEditAssignment({
  planId,
  assignment: a,
  changed,
}: {
  planId: string;
  assignment: PlanView['assignments'][number];
  changed: () => void;
}) {
  const [action, setAction] = useState<'reschedule' | 'cancel'>('reschedule'),
    [due, setDue] = useState(''),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<z.infer<typeof teacherAssignmentUpdateSchema> | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = pending.current ?? {
      operationId: crypto.randomUUID(),
      revision: a.revision,
      action,
      dueAt: action === 'cancel' ? null : date(due),
      reason,
    };
    pending.current = body;
    try {
      await api(`/teacher/plans/${planId}/assignments/${a.id}`, planViewSchema, { body });
      pending.current = null;
      setReason('');
      changed();
    } catch (e) {
      setError(t((e as Error).message));
      if (e instanceof ApiError && e.status && e.status < 500) {
        pending.current = null;
        if (['ASSIGNMENT_CHANGED', 'ASSIGNMENT_LOCKED'].includes(e.code ?? '')) changed();
      }
    } finally {
      setBusy(false);
    }
  }
  if (a.status !== 'pending') return null;
  return (
    <details className="teacher-assignment-edit">
      <summary>{t('Изменить назначение')}</summary>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy || Boolean(pending.current)}>
          <label htmlFor={`teacher-action-${a.id}`}>{t('Изменение назначения')}</label>
          <select
            id={`teacher-action-${a.id}`}
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
          >
            <option value="reschedule">{t('Изменить срок')}</option>
            <option value="cancel">{t('Отменить назначение')}</option>
          </select>
          {action === 'reschedule' && (
            <>
              <label htmlFor={`teacher-due-${a.id}`}>{t('Новая дата доступности')}</label>
              <input
                id={`teacher-due-${a.id}`}
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
              <p className="muted">{t('Пустая дата делает задание доступным сразу.')}</p>
            </>
          )}
          <label htmlFor={`teacher-change-reason-${a.id}`}>{t('Причина изменения')}</label>
          <textarea
            id={`teacher-change-reason-${a.id}`}
            rows={2}
            maxLength={3000}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </fieldset>
        <button className="secondary" disabled={busy || !reason.trim()}>
          {busy
            ? t('Сохраняем изменение…')
            : pending.current
              ? t('Повторить изменение')
              : t('Сохранить изменение назначения')}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  );
}
