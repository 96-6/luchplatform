import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  meetingsPageSchema,
  meetingOptionsSchema,
  meetingSchema,
  type Meeting,
  type createMeetingSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import { useAuth } from '../../auth/AuthContext';
import { api, ApiError } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { LoadingState, ErrorState } from '../../components/States';
import { addDay, browserZone, dateParts, zonedDate, statusLabels, meetingTime } from './shared';
export function SchedulePage() {
  const { session } = useAuth(),
    [params, setParams] = useSearchParams();
  const [zone, setZone] = useState(browserZone),
    [creating, setCreating] = useState(false);
  const mode =
    params.get('view') === 'month' ? 'month' : params.get('view') === 'agenda' ? 'agenda' : 'week';
  const raw = params.get('day'),
    day =
      raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(new Date(raw).getTime())
        ? raw
        : dateParts(new Date(), zone).slice(0, 10);
  const base = mode === 'month' ? `${day.slice(0, 7)}-01` : day;
  const weekday = (new Date(`${base}T12:00:00Z`).getUTCDay() + 6) % 7,
    start = addDay(base, -weekday),
    days = mode === 'month' ? 42 : 7;
  const range = useMemo(
    () => ({
      from: zonedDate(`${start}T00:00`, zone),
      to: zonedDate(`${addDay(start, days)}T00:00`, zone),
    }),
    [start, days, zone],
  );
  const { state, refresh } = useResource(
    `/meetings?${new URLSearchParams(range)}`,
    meetingsPageSchema,
  );
  const [extra, setExtra] = useState<Meeting[]>([]),
    [moreError, setMoreError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false);
  const [pageCursor, setPageCursor] = useState<z.infer<typeof meetingsPageSchema>['nextCursor']>();
  const key = range.from + range.to + zone;
  const previous = useRef(key);
  if (previous.current !== key) {
    previous.current = key;
    if (extra.length) setExtra([]);
    if (pageCursor !== undefined) setPageCursor(undefined);
  }
  const all = state.status === 'ready' ? [...state.data.items, ...extra] : [];
  const cursor =
    pageCursor === undefined && state.status === 'ready' ? state.data.nextCursor : pageCursor;
  const change = (nextDay = day, view = mode) => setParams({ day: nextDay, view });
  async function more() {
    if (!cursor) return;
    setBusy(true);
    try {
      const p = await api(
        `/meetings?${new URLSearchParams({ ...range, beforeStartsAt: cursor.startsAt, beforeId: cursor.id })}`,
        meetingsPageSchema,
      );
      setExtra((v) => [...v, ...p.items]);
      setPageCursor(p.nextCursor);
      setMoreError(null);
    } catch (e) {
      setMoreError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>Расписание</h1>
      <p>Время показано в часовом поясе {zone}. Встречи открываются в браузере.</p>
      <div className="calendar-toolbar">
        <button
          className="secondary"
          onClick={() =>
            change(
              mode === 'month'
                ? new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 2, 1))
                    .toISOString()
                    .slice(0, 10)
                : addDay(day, -7),
            )
          }
        >
          ← Назад
        </button>
        <button
          className="secondary"
          onClick={() => change(dateParts(new Date(), zone).slice(0, 10))}
        >
          Сегодня
        </button>
        <button
          className="secondary"
          onClick={() =>
            change(
              mode === 'month'
                ? new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 1))
                    .toISOString()
                    .slice(0, 10)
                : addDay(day, 7),
            )
          }
        >
          Вперёд →
        </button>
        <label>
          Дата
          <input
            aria-label="Дата календаря"
            type="date"
            value={day}
            onChange={(e) => change(e.target.value)}
          />
        </label>
        <label>
          Вид
          <select
            aria-label="Вид календаря"
            value={mode}
            onChange={(e) => change(day, e.target.value)}
          >
            <option value="week">Неделя</option>
            <option value="month">Месяц</option>
            <option value="agenda">Список</option>
          </select>
        </label>
        <label>
          Часовой пояс
          <select
            aria-label="Часовой пояс календаря"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          >
            {[
              ...new Set([
                browserZone(),
                'Europe/Moscow',
                'UTC',
                'Europe/London',
                'Europe/Berlin',
                'Asia/Shanghai',
                'Asia/Tokyo',
                'America/New_York',
              ]),
            ].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
        {['teacher', 'admin', 'superadmin'].includes(session.user!.role) && (
          <button onClick={() => setCreating((v) => !v)}>
            {creating ? 'Закрыть форму' : 'Запланировать занятие'}
          </button>
        )}
      </div>
      {creating && (
        <MeetingEditor
          zone={zone}
          initialDay={day}
          done={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
      {state.status === 'loading' ? (
        <LoadingState text="Загружаем расписание…" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <>
          <div
            className={mode === 'agenda' ? 'meeting-agenda' : 'calendar-grid'}
            aria-label="Календарь занятий"
          >
            {mode === 'agenda' ? (
              all.length ? (
                all.map((m) => <MeetingCard key={m.id} meeting={m} zone={zone} />)
              ) : (
                <p>На выбранную неделю занятий нет.</p>
              )
            ) : (
              Array.from({ length: days }, (_, i) => {
                const date = addDay(start, i),
                  items = all.filter(
                    (m) =>
                      dateParts(new Date(m.startsAt), zone).slice(0, 10) <= date &&
                      dateParts(new Date(Date.parse(m.endsAt) - 1), zone).slice(0, 10) >= date,
                  );
                return (
                  <section className="calendar-day" key={date}>
                    <h2>
                      {new Intl.DateTimeFormat('ru', {
                        day: 'numeric',
                        month: 'short',
                        weekday: 'short',
                        timeZone: 'UTC',
                      }).format(new Date(`${date}T12:00:00Z`))}
                    </h2>
                    {items.map((m) => (
                      <MeetingCard key={m.id} meeting={m} zone={zone} />
                    ))}
                  </section>
                );
              })
            )}
          </div>
          {!all.length && mode !== 'agenda' && <p>В этом периоде занятий пока нет.</p>}
          {cursor && (
            <button disabled={busy} className="secondary" onClick={() => void more()}>
              Загрузить остальные занятия периода
            </button>
          )}
          {moreError && <ErrorState error={moreError} retry={() => void more()} />}
        </>
      )}
    </>
  );
}
function MeetingCard({ meeting: m, zone }: { meeting: Meeting; zone: string }) {
  return (
    <article className={`calendar-meeting ${m.status}`} data-testid="calendar-meeting">
      <Link to={`/meetings/${m.id}`}>
        <strong>{m.title}</strong>
      </Link>
      <p>{meetingTime(m, zone)}</p>
      <p>
        {m.language === 'ru' ? 'РКИ' : 'Английский'} ·{' '}
        {m.members.filter((p) => p.role === 'student').length === 1
          ? 'Индивидуальное'
          : 'Групповое'}
      </p>
      <span className="badge">{statusLabels[m.status]}</span>
    </article>
  );
}
export function MeetingEditor({
  meeting,
  zone,
  initialDay,
  done,
}: {
  meeting?: Meeting;
  zone: string;
  initialDay?: string;
  done: () => void;
}) {
  const { session } = useAuth(),
    navigate = useNavigate();
  const opts = useResource('/meetings/options', meetingOptionsSchema);
  const [title, setTitle] = useState(meeting?.title ?? ''),
    [description, setDescription] = useState(meeting?.description ?? ''),
    [language, setLanguage] = useState<'ru' | 'en'>(meeting?.language ?? 'ru'),
    [tz, setTz] = useState(meeting?.timeZone ?? zone),
    [start, setStart] = useState(
      meeting
        ? dateParts(new Date(meeting.startsAt), meeting.timeZone)
        : `${initialDay ?? dateParts(new Date(), zone).slice(0, 10)}T18:00`,
    ),
    [duration, setDuration] = useState(
      meeting
        ? Math.round((Date.parse(meeting.endsAt) - Date.parse(meeting.startsAt)) / 60000)
        : 45,
    ),
    [organizer, setOrganizer] = useState(
      meeting?.organizer.id ?? (session.user?.role === 'teacher' ? session.user.id : ''),
    ),
    [students, setStudents] = useState<string[]>(
      meeting?.members.filter((m) => m.role === 'student').map((m) => m.id) ?? [],
    ),
    [cohosts, setCohosts] = useState<string[]>(
      meeting?.members
        .filter((m) => m.role === 'organizer' && m.id !== meeting.organizer.id)
        .map((m) => m.id) ?? [],
    ),
    [lobby, setLobby] = useState(meeting?.lobbyEnabled ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<(z.infer<typeof createMeetingSchema> & { revision?: number }) | null>(
    null,
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const startsAt = zonedDate(start, tz);
      const body = pending.current ?? {
        operationId: crypto.randomUUID(),
        title,
        description,
        language,
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + duration * 60000).toISOString(),
        timeZone: tz,
        organizerId: organizer,
        coorganizerIds: cohosts.filter((id) => id !== organizer),
        studentIds: students,
        lobbyEnabled: lobby,
        ...(meeting ? { revision: meeting.revision } : {}),
      };
      pending.current = body;
      const saved = await api(meeting ? `/meetings/${meeting.id}` : '/meetings', meetingSchema, {
        body,
      });
      pending.current = null;
      done();
      if (!meeting) navigate(`/meetings/${saved.id}`);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status && e.status < 500) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel"
      aria-label={meeting ? 'Изменение видеозанятия' : 'Новое видеозанятие'}
    >
      <h2>{meeting ? 'Изменить занятие' : 'Запланировать видеозанятие'}</h2>
      {opts.state.status === 'loading' ? (
        <LoadingState />
      ) : opts.state.status === 'error' ? (
        <ErrorState error={opts.state.error} retry={opts.refresh} />
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy || Boolean(pending.current)}>
            <div className="form-grid">
              <label>
                Название занятия
                <input
                  required
                  maxLength={160}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                Язык занятия
                <select
                  aria-label="Язык занятия"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as 'ru' | 'en')}
                >
                  <option value="ru">РКИ</option>
                  <option value="en">Английский</option>
                </select>
              </label>
              <label>
                Начало занятия
                <input
                  required
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label>
                Продолжительность, минут
                <input
                  required
                  type="number"
                  min={1}
                  max={480}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                />
              </label>
              <label>
                Часовой пояс занятия
                <select
                  aria-label="Часовой пояс занятия"
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                >
                  {[
                    ...new Set([
                      tz,
                      zone,
                      'Europe/Moscow',
                      'UTC',
                      'Europe/London',
                      'Europe/Berlin',
                      'Asia/Shanghai',
                      'America/New_York',
                    ]),
                  ].map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
              <label>
                Основной преподаватель
                <select
                  required
                  value={organizer}
                  disabled={session.user!.role === 'teacher'}
                  onChange={(e) => setOrganizer(e.target.value)}
                >
                  <option value="">Выберите преподавателя</option>
                  {opts.state.data.organizers
                    .filter((p) => p.role === 'teacher')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.email}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label>
              Описание занятия
              <textarea
                maxLength={3000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <fieldset>
              <legend>
                Ученики ·{' '}
                {students.length === 1 ? 'индивидуальное занятие' : `группа: ${students.length}`}
              </legend>
              {!opts.state.data.students.length && (
                <p>Сначала закрепите учеников за преподавателем.</p>
              )}
              <div className="meeting-picker">
                {opts.state.data.students.map((p) => (
                  <label className="checkbox" key={p.id}>
                    <input
                      type="checkbox"
                      checked={students.includes(p.id)}
                      onChange={(e) =>
                        setStudents((v) =>
                          e.target.checked ? [...v, p.id] : v.filter((x) => x !== p.id),
                        )
                      }
                    />
                    {p.name} · {p.email}
                  </label>
                ))}
              </div>
            </fieldset>
            <details>
              <summary>Дополнительные организаторы</summary>
              <p>Каждый преподаватель должен быть связан со всеми выбранными учениками.</p>
              {opts.state.data.organizers
                .filter((p) => p.id !== organizer)
                .map((p) => (
                  <label key={p.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={cohosts.includes(p.id)}
                      onChange={(e) =>
                        setCohosts((v) =>
                          e.target.checked ? [...v, p.id] : v.filter((x) => x !== p.id),
                        )
                      }
                    />
                    {p.name} · {p.email}
                  </label>
                ))}
            </details>
            <label className="checkbox">
              <input type="checkbox" checked={lobby} onChange={(e) => setLobby(e.target.checked)} />
              Зал ожидания: организатор допускает учеников
            </label>
          </fieldset>
          <button disabled={busy || !students.length}>
            {busy
              ? 'Сохраняем…'
              : pending.current
                ? 'Повторить сохранение занятия'
                : meeting
                  ? 'Сохранить расписание'
                  : 'Создать занятие'}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
