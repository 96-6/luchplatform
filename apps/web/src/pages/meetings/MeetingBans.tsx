import { useEffect, useRef, useState } from 'react';
import {
  meetingBanConfirmationSchema,
  meetingIpBanSchema,
  meetingIpBansPageSchema,
  type MeetingIpBan,
} from '@luch/contracts';
import { api, ApiError } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { ErrorState, LoadingState } from '../../components/States';
import { HoldToConfirm } from '../../components/HoldToConfirm';
import { t, dateLocale } from '../../i18n';
import { useAuth } from '../../auth/AuthContext';

export function GuestIpBanDialog({
  meetingId,
  sessionId,
  name,
  existing,
  done,
  cancel,
}: {
  meetingId: string;
  sessionId?: string;
  name?: string;
  existing?: MeetingIpBan;
  done: () => void;
  cancel: () => void;
}) {
  const [ip, setIp] = useState(existing?.ip ?? ''),
    [reason, setReason] = useState(existing?.reason ?? ''),
    [active, setActive] = useState(existing?.active ?? true);
  const operation = useRef(crypto.randomUUID()),
    [observed, setObserved] = useState('');
  const prepared = useRef<ReturnType<typeof meetingBanConfirmationSchema.parse> | null>(null);
  const changed = () => {
    operation.current = crypto.randomUUID();
    prepared.current = null;
    setObserved('');
  };
  return (
    <HoldToConfirm
      title={existing ? t('Изменить блокировку гостевого IP') : t('Заблокировать гостевой IP')}
      valid={Boolean(reason.trim() && (sessionId || ip.trim()))}
      prepare={async () => {
        // Retry the same confirmation after a lost reply, even if removal changed the guest/revision.
        if (prepared.current) return prepared.current;
        const result = await api(
          existing
            ? `/meeting-ip-bans/${existing.id}/prepare`
            : `/meetings/${meetingId}/ip-bans/prepare`,
          meetingBanConfirmationSchema,
          {
            body: existing
              ? { operationId: operation.current, revision: existing.revision, ip, reason, active }
              : { operationId: operation.current, ...(sessionId ? { sessionId } : { ip }), reason },
          },
        );
        prepared.current = result;
        setObserved(result.ip);
        return result;
      }}
      confirm={async (confirmation) => {
        try {
          await api('/meeting-ip-bans/confirm', meetingIpBanSchema, {
            body: { confirmationId: confirmation.id },
          });
          done();
        } catch (error) {
          if (error instanceof ApiError && error.code === 'BAN_CONFIRMATION_EXPIRED')
            prepared.current = null;
          throw error;
        }
      }}
      cancel={cancel}
    >
      {name && <p>{t('Гость: {0}', [name])}</p>}
      {!sessionId && (
        <label>
          {t('IP-адрес')}
          <input
            value={ip}
            maxLength={64}
            onChange={(e) => {
              setIp(e.target.value);
              changed();
            }}
          />
        </label>
      )}
      <p className="meeting-ban-target-ip">{t('IP-адрес: {0}', [observed || ip || '…'])}</p>
      <p>
        {t(
          'Блокировка закрывает гостевой вход с этого IP во встречу и следующие встречи по тому же приглашению. Другие гости из общей сети тоже могут потерять доступ. Зарегистрированные аккаунты не блокируются по этому IP.',
        )}
      </p>
      <label>
        {t('Причина блокировки')}
        <textarea
          value={reason}
          maxLength={1000}
          required
          onChange={(e) => {
            setReason(e.target.value);
            changed();
          }}
        />
      </label>
      {existing && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => {
              setActive(e.target.checked);
              changed();
            }}
          />
          {t('Блокировка действует')}
        </label>
      )}
    </HoldToConfirm>
  );
}
export function MeetingIpBans({
  meetingId,
  revision = 0,
}: {
  meetingId?: string;
  revision?: number;
}) {
  const { session } = useAuth();
  const [version, setVersion] = useState(0),
    [editing, setEditing] = useState<MeetingIpBan | null>(null),
    [adding, setAdding] = useState(false);
  const [older, setOlder] = useState<MeetingIpBan[]>([]),
    [cursor, setCursor] = useState<{ createdAt: string; id: string } | null | undefined>(),
    [moreError, setMoreError] = useState<Error | null>(null);
  const query = meetingId ? `meetingId=${meetingId}&` : '';
  const { state, refresh } = useResource(
    `/meeting-ip-bans?${query}limit=25`,
    meetingIpBansPageSchema,
  );
  const key = `${meetingId}:${revision}:${version}`;
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current !== key) {
      previous.current = key;
      setOlder([]);
      setCursor(undefined);
      setMoreError(null);
      refresh();
    }
  }, [key, refresh]);
  const changed = () => {
    setEditing(null);
    setAdding(false);
    setVersion((v) => v + 1);
  };
  const next = cursor === undefined && state.status === 'ready' ? state.data.nextCursor : cursor;
  async function more() {
    if (!next) return;
    try {
      const data = await api(
        `/meeting-ip-bans?${query}limit=25&beforeCreatedAt=${encodeURIComponent(next.createdAt)}&beforeId=${next.id}`,
        meetingIpBansPageSchema,
      );
      setOlder((v) => [...v, ...data.items]);
      setCursor(data.nextCursor);
      setMoreError(null);
    } catch (e) {
      setMoreError(e as Error);
    }
  }
  return (
    <section className="panel meeting-ban-register" aria-label={t('База блокировок гостевых IP')}>
      <h2>{t('База блокировок гостевых IP')}</h2>
      <p>
        {session.user?.role === 'superadmin'
          ? t('Суперадмин видит и изменяет все блокировки.')
          : t(
              'Вы можете изменять свои блокировки. В карточке встречи организаторы также видят блокировки этого приглашения.',
            )}
      </p>
      <div className="button-row">
        <button className="secondary" onClick={() => setVersion((v) => v + 1)}>
          {t('Обновить список блокировок')}
        </button>
        {meetingId && (
          <button className="danger" onClick={() => setAdding(true)}>
            {t('Добавить блокировку IP')}
          </button>
        )}
      </div>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <>
          {!state.data.items.length && <p>{t('Блокировок гостевых IP пока нет.')}</p>}
          {[...state.data.items, ...older].map((b) => (
            <article key={b.id} className="meeting-ban-entry">
              <h3>
                {b.ip} · {t(b.targetName)} · {b.active ? t('Действует') : t('Отозвана')}
              </h3>
              <p>{b.meetingTitle}</p>
              <p>{t('Причина: {0}', [b.reason])}</p>
              <p>
                {t('Автор: {0} · {1}', [
                  `${b.owner.name} (${b.owner.email})`,
                  new Date(b.createdAt).toLocaleString(dateLocale),
                ])}
              </p>
              <p>
                {t('Изменил: {0} · {1}', [
                  `${b.updatedBy.name} (${b.updatedBy.email})`,
                  new Date(b.updatedAt).toLocaleString(dateLocale),
                ])}
              </p>
              {b.canEdit && (
                <button
                  className="secondary"
                  onClick={() => setEditing(b)}
                  aria-label={t('Изменить блокировку {0}', [b.ip])}
                >
                  {t('Изменить блокировку')}
                </button>
              )}
              <details>
                <summary>{t('История блокировки')}</summary>
                <ol>
                  {b.history.map((e) => (
                    <li key={e.id}>
                      <strong>
                        {new Date(e.createdAt).toLocaleString(dateLocale)} · {e.actor.name} (
                        {e.actor.email})
                      </strong>
                      <p>
                        {e.before && `${e.before.ip} → `}
                        {e.after.ip} · {e.after.active ? t('Действует') : t('Отозвана')}
                      </p>
                      {e.before && <p>{t('Прежняя причина: {0}', [e.before.reason])}</p>}
                      <p>{t('Причина: {0}', [e.after.reason])}</p>
                    </li>
                  ))}
                </ol>
              </details>
            </article>
          ))}
          {next && (
            <button className="secondary" onClick={() => void more()}>
              {t('Предыдущие блокировки')}
            </button>
          )}
        </>
      )}
      {moreError && <ErrorState error={moreError} retry={() => void more()} />}
      {(editing || adding) && (
        <GuestIpBanDialog
          key={editing?.id ?? 'new'}
          meetingId={editing?.meetingId ?? meetingId!}
          {...(editing ? { existing: editing } : {})}
          done={changed}
          cancel={() => {
            setEditing(null);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}
