import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  providerSettingsSchema,
  providerRequestsSchema,
  type AiCeilings,
  type AiControls,
} from '@luch/contracts';
import type { z } from 'zod';
import { AvatarBindings } from '../components/AvatarBindings';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState } from '../components/States';
import { UserSummary } from './AccountPages';
type View = z.infer<typeof providerSettingsSchema>;
const usd = (micros: number) =>
  `${(micros / 1_000_000).toLocaleString('ru-RU', { minimumFractionDigits: 6, maximumFractionDigits: 6 })} USD`;
const moneyLabels = {
  lifetimeMicros: 'Общий бюджет, USD',
  dailyMicros: 'Лимит в день, USD',
  monthlyMicros: 'Лимит в месяц, USD',
  perUserDailyMicros: 'На одного ученика в день, USD',
};
const numberLabels = {
  requestsPerUserDay: 'Запросов на ученика в день',
  maxOutputTokens: 'Максимум токенов ответа',
  maxTtsCharacters: 'Максимум символов озвучивания',
  maxVideoSeconds: 'Максимум секунд видео HeyGen',
  maxVideoCharacters: 'Максимум символов реплики HeyGen',
  maxConcurrent: 'Одновременных запросов',
  pricingValidityHours: 'Срок подтверждения цены, часы',
};
export function OperationsPage() {
  const { session } = useAuth();
  return (
    <>
      <h1>Кабинет администратора</h1>
      <section className="panel">
        <UserSummary user={session.user!} />
        <p>Настройки адаптации доступны в пределах ограничений суперадмина.</p>
        <Link to="/admin/providers">AI, озвучивание и расходы →</Link>
      </section>
    </>
  );
}
export function ProviderPage() {
  const resource = useResource('/admin/providers', providerSettingsSchema),
    [view, setView] = useState<View | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [message, setMessage] = useState(''),
    [ledgerRevision, setLedgerRevision] = useState(0);
  useEffect(() => {
    if (resource.state.status === 'ready') setView(resource.state.data);
  }, [resource.state]);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      setView(await api(path, providerSettingsSchema, { body }));
      setMessage('Настройки сохранены.');
      setLedgerRevision((r) => r + 1);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return resource.state.status === 'error' ? (
      <ErrorState error={resource.state.error} retry={resource.refresh} />
    ) : (
      <LoadingState />
    );
  return (
    <>
      <h1>AI, озвучивание и расходы</h1>
      <p>
        Генеративные варианты — OpenAI или NeuroAPI. Listening — ElevenLabs. Видеоаватары — HeyGen.
        При недоступности генерации задания продолжаются из учебного банка.
      </p>
      <section className="notice">
        <p>
          Обращения разрешаются после проверки лимитов. Учёт ведётся в USD по заданным верхним
          ценам, день и месяц — UTC. Неопределённый сбой сохраняет зарезервированную сумму.
        </p>
        <p>
          Цены нужно сверять с вашим тарифом, включая пиковые надбавки. Для ограничения общего счёта
          задайте лимиты также у провайдера: здесь учитываются вызовы этого приложения.
        </p>
      </section>
      <section className="panel">
        <h2>Учтённые расходы</h2>
        <p>
          Всего: {usd(view.spend.lifetimeMicros)} · Сегодня: {usd(view.spend.dailyMicros)} · Этот
          месяц: {usd(view.spend.monthlyMicros)}
        </p>
        <p>
          Запросов в работе: {view.spend.pending}. Общий бюджет: {usd(view.ceilings.lifetimeMicros)}
          .
        </p>
      </section>
      {message && <p role="status">{message}</p>}
      {error && (
        <ErrorState
          error={error}
          retry={() => {
            setError(null);
            resource.refresh();
          }}
        />
      )}
      <ControlsForm key={`controls-${view.revision}`} view={view} busy={busy} save={save} />
      {view.canManageSecrets && (
        <CeilingsForm key={`ceilings-${view.revision}`} view={view} busy={busy} save={save} />
      )}
      {view.canManageSecrets && <AvatarBindings changed={resource.refresh} />}
      <h2>Подключения и цены</h2>
      {!view.canManageSecrets && (
        <p>Ключи, модели, цены и верхние ограничения меняет суперадмин.</p>
      )}
      <div className="provider-grid">
        {view.providers.map((p) => (
          <ProviderForm
            key={`${p.id}-${p.revision}`}
            provider={p}
            writable={view.canManageSecrets}
            busy={busy}
            save={save}
          />
        ))}
      </div>
      <ProviderLedger key={ledgerRevision} />
    </>
  );
}
type Save = (path: string, body: unknown) => Promise<void>;
function NumericFields({
  data,
  set,
  ceilings,
  idPrefix,
  canManageVideo = true,
}: {
  data: AiCeilings | AiControls;
  set: (key: string, value: number) => void;
  ceilings?: AiCeilings;
  idPrefix: string;
  canManageVideo?: boolean;
}) {
  return (
    <>
      {Object.entries(moneyLabels)
        .filter(([key]) => key in data)
        .map(([key, label]) => (
          <div key={key}>
            <label htmlFor={`${idPrefix}-${key}`}>{label}</label>
            <input
              id={`${idPrefix}-${key}`}
              type="number"
              min={0}
              step="0.000001"
              required
              max={
                ceilings && key in ceilings
                  ? (ceilings[key as keyof AiCeilings] as number) / 1_000_000
                  : 1_000_000
              }
              value={(data[key as keyof typeof data] as number) / 1_000_000}
              onChange={(e) => set(key, Math.round(Number(e.target.value) * 1_000_000))}
            />
          </div>
        ))}
      {Object.entries(numberLabels)
        .filter(([key]) => key in data)
        .map(([key, label]) => (
          <div key={key}>
            <label htmlFor={`${idPrefix}-${key}`}>{label}</label>
            <input
              id={`${idPrefix}-${key}`}
              type="number"
              min={
                key === 'maxOutputTokens'
                  ? 128
                  : key === 'maxConcurrent' || key === 'pricingValidityHours'
                    ? 1
                    : 0
              }
              step={1}
              required
              max={
                ceilings && key in ceilings
                  ? (ceilings[key as keyof AiCeilings] as number)
                  : undefined
              }
              disabled={
                !canManageVideo && (key === 'maxVideoSeconds' || key === 'maxVideoCharacters')
              }
              value={data[key as keyof typeof data] as number}
              onChange={(e) => set(key, Number(e.target.value))}
            />
          </div>
        ))}
    </>
  );
}
function ControlsForm({ view, busy, save }: { view: View; busy: boolean; save: Save }) {
  const [data, setData] = useState(view.controls);
  const set = (key: string, value: number) => setData((d) => ({ ...d, [key]: value }));
  function submit(e: FormEvent) {
    e.preventDefault();
    void save('/admin/providers/controls', { revision: view.revision, controls: data });
  }
  return (
    <section className="panel">
      <h2>Настройки адаптации</h2>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.enabled}
              onChange={(e) => setData({ ...data, enabled: e.target.checked })}
            />
            Генерировать варианты дополнительных заданий
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.listeningEnabled}
              onChange={(e) =>
                setData({
                  ...data,
                  listeningEnabled: e.target.checked,
                  withListening: e.target.checked ? data.withListening : false,
                })
              }
            />
            Разрешить озвучивание ElevenLabs
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.withListening}
              disabled={!data.listeningEnabled}
              onChange={(e) => setData({ ...data, withListening: e.target.checked })}
            />
            Добавлять listening-варианты при генерации
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.videoEnabled}
              disabled={!view.canManageSecrets}
              onChange={(e) => setData({ ...data, videoEnabled: e.target.checked })}
            />
            Разрешить генерацию видео HeyGen
          </label>
          <label htmlFor="ai-strategy">Выбор текстового провайдера</label>
          <select
            id="ai-strategy"
            value={data.strategy}
            onChange={(e) =>
              setData({ ...data, strategy: e.target.value as AiControls['strategy'] })
            }
          >
            <option value="cheapest">Меньшая стоимость по настроенным ценам</option>
            <option value="openai">OpenAI</option>
            <option value="neuroapi">NeuroAPI</option>
          </select>
          <label htmlFor="review-delay">Повторение через, часы</label>
          <input
            id="review-delay"
            type="number"
            min={24}
            max={336}
            step={1}
            required
            value={data.reviewDelayHours}
            onChange={(e) => setData({ ...data, reviewDelayHours: Number(e.target.value) })}
          />
          <div className="settings-grid">
            <NumericFields
              data={data}
              set={set}
              ceilings={view.ceilings}
              idPrefix="controls"
              canManageVideo={view.canManageSecrets}
            />
          </div>
          <p className="muted">
            При выключенном AI адаптация работает по правилам. Нулевой денежный лимит запрещает
            новые платные вызовы. Доступ к ключам здесь не предоставляется.
          </p>
          <button>Сохранить настройки адаптации</button>
        </fieldset>
      </form>
    </section>
  );
}
function CeilingsForm({ view, busy, save }: { view: View; busy: boolean; save: Save }) {
  const [data, setData] = useState(view.ceilings);
  return (
    <section className="panel">
      <h2>Ограничения суперадмина</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save('/admin/providers/ceilings', { revision: view.revision, ceilings: data });
        }}
      >
        <fieldset disabled={busy}>
          <div className="settings-grid">
            <NumericFields
              data={data}
              set={(key, value) => setData((d) => ({ ...d, [key]: value }))}
              idPrefix="ceilings"
            />
          </div>
          <p className="muted">
            Администратор может менять рабочие настройки только в этих пределах. Снижение
            ограничений уменьшает соответствующие рабочие лимиты.
          </p>
          <button>Сохранить верхние ограничения</button>
        </fieldset>
      </form>
    </section>
  );
}
function ProviderForm({
  provider: p,
  writable,
  busy,
  save,
}: {
  provider: View['providers'][number];
  writable: boolean;
  busy: boolean;
  save: Save;
}) {
  const [data, setData] = useState(p),
    [key, setKey] = useState(''),
    [clearKey, setClearKey] = useState(false),
    [confirmPricing, setConfirmPricing] = useState(false);
  const name =
    p.id === 'openai'
      ? 'OpenAI'
      : p.id === 'neuroapi'
        ? 'NeuroAPI'
        : p.id === 'elevenlabs'
          ? 'ElevenLabs'
          : 'HeyGen';
  const rate = (
    field: 'inputRate' | 'outputRate' | 'characterRate' | 'minuteRate',
    label: string,
  ) => (
    <>
      <label htmlFor={`${p.id}-${field}`}>{label}</label>
      <input
        id={`${p.id}-${field}`}
        type="number"
        min="0.000001"
        step="0.000001"
        value={data[field] === null ? '' : data[field]! / 1_000_000}
        onChange={(e) =>
          setData({
            ...data,
            [field]: e.target.value === '' ? null : Math.round(Number(e.target.value) * 1_000_000),
          })
        }
      />
    </>
  );
  return (
    <section className="panel" data-testid={`provider-${p.id}`}>
      <h3>{name}</h3>
      <p>
        Ключ: {p.keyConfigured ? 'настроен' : 'не настроен'} ·{' '}
        {p.enabled ? 'подключение включено' : 'выключено'}
      </p>
      <p className="muted">
        Цена подтверждена:{' '}
        {p.pricingConfirmedAt
          ? new Date(p.pricingConfirmedAt).toLocaleString('ru-RU')
          : 'не подтверждена'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(`/admin/providers/${p.id}`, {
            revision: p.revision,
            enabled: data.enabled,
            model: data.model,
            voiceRu: data.voiceRu,
            voiceEn: data.voiceEn,
            inputRate: data.inputRate,
            outputRate: data.outputRate,
            characterRate: data.characterRate,
            minuteRate: data.minuteRate,
            confirmPricing,
            clearKey,
            ...(key ? { apiKey: key } : {}),
          });
        }}
      >
        <fieldset disabled={busy || !writable}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.enabled}
              onChange={(e) => setData({ ...data, enabled: e.target.checked })}
            />
            Включить {name}
          </label>
          <label htmlFor={`${p.id}-model`}>Модель {name}</label>
          <input
            id={`${p.id}-model`}
            maxLength={100}
            required
            value={data.model}
            onChange={(e) => setData({ ...data, model: e.target.value })}
          />
          {p.id === 'heygen' ? (
            <>
              {rate('minuteRate', 'Верхняя цена HeyGen, USD за минуту видео')}
              <p>
                Движки: avatar_iv, avatar_v или avatar_iii. Голоса и аватары настраиваются выше.
              </p>
            </>
          ) : p.id === 'elevenlabs' ? (
            <>
              {rate('characterRate', 'Верхняя цена USD за 1000 символов')}
              <label htmlFor="voice-ru">Голос ElevenLabs для РКИ</label>
              <input
                id="voice-ru"
                value={data.voiceRu}
                onChange={(e) => setData({ ...data, voiceRu: e.target.value })}
              />
              <label htmlFor="voice-en">Голос ElevenLabs для английского</label>
              <input
                id="voice-en"
                value={data.voiceEn}
                onChange={(e) => setData({ ...data, voiceEn: e.target.value })}
              />
            </>
          ) : (
            <>
              {rate('inputRate', `Цена входа ${name}, USD за 1 млн токенов`)}
              {rate('outputRate', `Цена выхода ${name}, USD за 1 млн токенов`)}
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmPricing}
              onChange={(e) => setConfirmPricing(e.target.checked)}
            />
            Подтверждаю верхние цены текущего тарифа {name}
          </label>
          {writable && (
            <>
              <label htmlFor={`${p.id}-key`}>Новый ключ {name}</label>
              <input
                id={`${p.id}-key`}
                type="password"
                autoComplete="new-password"
                maxLength={512}
                value={key}
                disabled={clearKey}
                placeholder="Пустое поле сохраняет прежний ключ"
                onChange={(e) => setKey(e.target.value)}
              />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => {
                    setClearKey(e.target.checked);
                    if (e.target.checked) {
                      setKey('');
                      setData({ ...data, enabled: false });
                    }
                  }}
                />
                Удалить ключ {name} и выключить подключение
              </label>
            </>
          )}
          {writable && <button>Сохранить подключение {name}</button>}
        </fieldset>
      </form>
    </section>
  );
}
function ProviderLedger() {
  const { state, refresh } = useResource('/admin/providers/requests', providerRequestsSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const labels = {
    reserved: 'В работе',
    success: 'Получен результат',
    failed: 'Сбой',
    unknown: 'Неопределённый результат',
    overrun: 'Превышение оценки расходов',
  };
  return (
    <section className="panel">
      <h2>Последние запросы к провайдерам</h2>
      {!state.data.items.length ? (
        <p>Платных запросов ещё нет.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Сервис</th>
                <th>Статус</th>
                <th>Учтено</th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString('ru-RU')}</td>
                  <td>
                    {r.provider}
                    <br />
                    {r.model}
                  </td>
                  <td>{labels[r.status]}</td>
                  <td>{usd(r.chargedMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
