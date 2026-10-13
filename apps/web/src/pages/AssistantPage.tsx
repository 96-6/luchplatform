import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { assistantProfileSchema, runsPageSchema, type AssistantPreferences } from '@luch/contracts';
import type { z } from 'zod';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState } from '../components/States';

type Profile = z.infer<typeof assistantProfileSchema>;
export function AssistantPage() {
  const [params] = useSearchParams(),
    userId = params.get('userId');
  const [saved, setSaved] = useState(false);
  const resource = useResource(
    `/assistant/profile${userId ? '?userId=' + encodeURIComponent(userId) : ''}`,
    assistantProfileSchema,
  );
  if (resource.state.status === 'loading') return <LoadingState text="Загружаем помощника…" />;
  if (resource.state.status === 'error')
    return <ErrorState error={resource.state.error} retry={resource.refresh} />;
  return (
    <>
      <h1>Ваш помощник</h1>
      <p>
        Демо-помощник — сценарный учебный помощник. Он объясняет задания и предлагает короткие
        диалоги по материалу урока.
      </p>
      <AssistantSelection
        key={resource.state.data.revision}
        profile={resource.state.data}
        refresh={resource.refresh}
        notify={setSaved}
      />
      {saved && <p role="status">Помощник сохранён.</p>}
      <AssistantRuns userId={userId} />
    </>
  );
}
function AssistantSelection({
  profile,
  refresh,
  notify,
}: {
  profile: Profile;
  refresh: () => void;
  notify: (saved: boolean) => void;
}) {
  const [preferences, setPreferences] = useState(profile.preferences),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  function set<K extends keyof AssistantPreferences>(key: K, value: AssistantPreferences[K]) {
    setPreferences((p) => ({ ...p, [key]: value }));
    notify(false);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/assistant/profile', assistantProfileSchema, {
        body: { userId: profile.userId, revision: profile.revision, preferences },
      });
      notify(true);
      refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Выберите персонажа</h2>
      <p>
        Рекомендация: {profile.avatars.find((a) => a.id === profile.recommendedAvatarId)?.style}.
        Выбор можно изменить в любой момент.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={busy || !profile.writable}>
          <legend>Три демонстрационных аватара</legend>
          <div className="avatar-grid">
            {profile.avatars.map((a) => (
              <label
                key={a.id}
                className={`avatar-card ${preferences.avatarId === a.id ? 'selected' : ''}`}
              >
                <img
                  className={preferences.animation ? 'avatar-animated' : ''}
                  src={a.image}
                  alt={a.name}
                  width="160"
                  height="160"
                />
                <span>
                  <input
                    type="radio"
                    name="avatar"
                    checked={preferences.avatarId === a.id}
                    onChange={() => set('avatarId', a.id)}
                  />
                  <strong>{a.name}</strong>
                </span>
                <span>{a.style}</span>
                <small>{a.description}</small>
              </label>
            ))}
          </div>
          <div className="settings-grid">
            <div>
              <label htmlFor="assistant-voice">Голос персонажа для видео</label>
              <select
                id="assistant-voice"
                value={preferences.voiceAvatarId}
                onChange={(e) =>
                  set('voiceAvatarId', e.target.value as AssistantPreferences['voiceAvatarId'])
                }
              >
                {profile.avatars.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.style}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="assistant-address">Обращение</label>
              <select
                id="assistant-address"
                value={preferences.address}
                onChange={(e) => set('address', e.target.value as AssistantPreferences['address'])}
              >
                <option value="formal">На «вы»</option>
                <option value="informal">На «ты»</option>
              </select>
            </div>
            <div>
              <label htmlFor="assistant-pace">Темп видео</label>
              <select
                id="assistant-pace"
                value={preferences.pace}
                onChange={(e) => set('pace', e.target.value as AssistantPreferences['pace'])}
              >
                <option value="slow">Спокойный</option>
                <option value="normal">Обычный</option>
                <option value="fast">Быстрый</option>
              </select>
            </div>
            <div>
              <label htmlFor="assistant-detail">Объяснения</label>
              <select
                id="assistant-detail"
                value={preferences.detail}
                onChange={(e) => set('detail', e.target.value as AssistantPreferences['detail'])}
              >
                <option value="brief">Краткие</option>
                <option value="detailed">Подробные</option>
              </select>
            </div>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={preferences.animation}
              onChange={(e) => set('animation', e.target.checked)}
            />
            Простая анимация персонажа
          </label>
          <p className="muted">
            Видео и озвученный голос доступны после настройки HeyGen суперадмином. Текстовые
            объяснения работают сразу.
          </p>
          <button>{busy ? 'Сохраняем…' : 'Сохранить помощника'}</button>
        </fieldset>
      </form>
      {error && <ErrorState error={error} retry={refresh} />}
    </section>
  );
}
function AssistantRuns({ userId }: { userId: string | null }) {
  const resource = useResource(
    `/engine/runs${userId ? '?userId=' + encodeURIComponent(userId) : ''}`,
    runsPageSchema,
  );
  if (resource.state.status === 'loading') return <LoadingState />;
  if (resource.state.status === 'error')
    return <ErrorState error={resource.state.error} retry={resource.refresh} />;
  return (
    <section className="panel">
      <h2>Чаты по урокам</h2>
      {resource.state.data.items.length ? (
        <ul className="lesson-list">
          {resource.state.data.items.map((r) => (
            <li key={r.id}>
              <Link to={`/learning/runs/${r.id}`}>
                {r.title} · {r.status === 'active' ? 'Продолжить' : 'История'}
              </Link>
              <span className="muted"> · {r.user.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          Откройте первое упражнение — помощник получит его материал и сохранит разговор.{' '}
          <Link to="/courses">Выбрать маршрут →</Link>
        </p>
      )}
    </section>
  );
}
