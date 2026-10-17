import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usersSchema } from '@luch/contracts';
import { useAuth } from '../auth/AuthContext';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState, EmptyState } from './States';
export function StudentDirectory({
  path,
  title = 'Выберите ученика',
}: {
  path: string;
  title?: string;
}) {
  const { session } = useAuth(),
    [search, setSearch] = useState('');
  const root = session.user?.role === 'superadmin';
  const { state, refresh } = useResource(
    root
      ? `/admin/accounts?role=student&search=${encodeURIComponent(search)}`
      : '/teacher/students',
    usersSchema,
  );
  return (
    <section className="panel">
      <h2>{title}</h2>
      <label htmlFor="directory-search">Найти ученика</label>
      <input
        id="directory-search"
        value={search}
        maxLength={100}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Имя или почта"
      />
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        (() => {
          const users = state.data.filter((u) =>
            `${u.name} ${u.email}`.toLowerCase().includes(search.toLowerCase()),
          );
          return users.length ? (
            <ul className="account-list">
              {users.map((u) => (
                <li key={u.id}>
                  <strong>{u.name}</strong>
                  <span>{u.email}</span>
                  <Link to={`${path}?userId=${u.id}`}>Открыть →</Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Ученики не найдены"
              description={
                root
                  ? 'Уточните поиск или создайте аккаунт в кабинете суперадмина.'
                  : 'Уточните поиск. Закрепление учеников выполняется в кабинете суперадмина.'
              }
            />
          );
        })()
      )}
      {root && (
        <p>
          <Link to="/admin">Аккаунты и закрепление преподавателей →</Link>
        </p>
      )}
    </section>
  );
}
