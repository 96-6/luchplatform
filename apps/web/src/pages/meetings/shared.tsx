import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { meetingsPageSchema, type Meeting } from '@luch/contracts';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { ErrorState, LoadingState } from '../../components/States';
export const okSchema = z.object({ ok: z.boolean() });
export const statusLabels = {
  scheduled: 'Запланировано',
  live: 'Идёт встреча',
  completed: 'Завершено',
  cancelled: 'Отменено',
};
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export function dateParts(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`;
}
export function zonedDate(local: string, zone: string) {
  const [day, time = '00:00'] = local.split('T'),
    target = new Date(`${day}T${time}:00Z`).getTime();
  let ms = target;
  for (let i = 0; i < 4; i++) {
    const observed = new Date(`${dateParts(new Date(ms), zone)}:00Z`).getTime();
    ms += target - observed;
  }
  if (!Number.isFinite(ms) || dateParts(new Date(ms), zone) !== `${day}T${time}`)
    throw Error('Это местное время отсутствует из-за перевода часов. Выберите другое время.');
  return new Date(ms).toISOString();
}
export const addDay = (day: string, n: number) =>
  new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
export const meetingTime = (m: Meeting, zone = m.timeZone) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: zone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(m.startsAt));
export function usePolling<T extends z.ZodType>(path: string, schema: T, interval = 2000) {
  const [data, setData] = useState<z.infer<T> | null>(null),
    [error, setError] = useState<Error | null>(null);
  const active = useRef(false),
    generation = useRef(0);
  const refresh = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    const gen = generation.current;
    try {
      const d = await api(path, schema);
      if (gen === generation.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (gen === generation.current) setError(e as Error);
    } finally {
      active.current = false;
    }
  }, [path, schema]);
  useEffect(() => {
    generation.current++;
    setData(null);
    setError(null);
    void refresh();
    const timer = setInterval(() => void refresh(), interval);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [refresh, interval]);
  return { data, error, refresh };
}
export function UpcomingMeetings() {
  const range = useRef({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date(Date.now() + 14 * 86400000).toISOString(),
  });
  const { state, refresh } = useResource(
    `/meetings?${new URLSearchParams({ ...range.current, limit: '50' })}`,
    meetingsPageSchema,
  );
  return (
    <section className="panel" aria-label="Ближайшие видеозанятия">
      <h2>Видеозанятия</h2>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : state.data.items.filter(
          (m) => m.status === 'scheduled' || m.status === 'live' || m.summaryComment,
        ).length ? (
        <ul className="meeting-agenda">
          {state.data.items
            .filter((m) => m.status === 'scheduled' || m.status === 'live' || m.summaryComment)
            .slice(0, 5)
            .map((m) => (
              <li key={m.id}>
                <Link to={`/meetings/${m.id}`}>
                  <strong>{m.title}</strong>
                </Link>
                <p>
                  {meetingTime(m, browserZone())} · {statusLabels[m.status]}
                </p>
                {m.summaryComment && <p>Итог: {m.summaryComment}</p>}
              </li>
            ))}
        </ul>
      ) : (
        <p>Назначенных видеозанятий пока нет.</p>
      )}
      <Link to="/schedule">Открыть расписание →</Link>
    </section>
  );
}
