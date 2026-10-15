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
      setError((e as Error).message);
      if (e instanceof ApiError && e.status && e.status < 500) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Назначение преподавателя">
      <h2>Назначить упражнение</h2>
      <p>
        Выберите задание из закреплённого маршрута. Ученик получит его в своём плане с указанной
        причиной.
      </p>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy || Boolean(pending.current)}>
            <label htmlFor="teacher-exercise">Упражнение для ученика</label>
            <select
              id="teacher-exercise"
              required
              value={exerciseId}
              onChange={(e) => setExerciseId(e.target.value)}
            >
              <option value="">Выберите упражнение</option>
              {state.data.items.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.lessonTitle} · {e.purpose === 'control' ? 'Контроль' : 'Тренировка'} ·{' '}
                  {e.instruction}
                </option>
              ))}
            </select>
            <label htmlFor="teacher-due">Открыть задание с даты</label>
            <input
              id="teacher-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <p className="muted">Время вашего устройства. Пустая дата — доступно сразу.</p>
            <label htmlFor="teacher-reason">Причина назначения</label>
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
              ? 'Сохраняем назначение…'
              : pending.current
                ? 'Повторить назначение'
                : 'Назначить ученику'}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && <p role="status">Упражнение назначено. Оно доступно ученику в плане.</p>}
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
      setError((e as Error).message);
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
      <summary>Изменить назначение</summary>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy || Boolean(pending.current)}>
          <label htmlFor={`teacher-action-${a.id}`}>Изменение назначения</label>
          <select
            id={`teacher-action-${a.id}`}
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
          >
            <option value="reschedule">Изменить срок</option>
            <option value="cancel">Отменить назначение</option>
          </select>
          {action === 'reschedule' && (
            <>
              <label htmlFor={`teacher-due-${a.id}`}>Новая дата доступности</label>
              <input
                id={`teacher-due-${a.id}`}
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
              <p className="muted">Пустая дата делает задание доступным сразу.</p>
            </>
          )}
          <label htmlFor={`teacher-change-reason-${a.id}`}>Причина изменения</label>
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
            ? 'Сохраняем изменение…'
            : pending.current
              ? 'Повторить изменение'
              : 'Сохранить изменение назначения'}
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
