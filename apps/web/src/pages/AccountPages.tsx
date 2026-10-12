import { Link, useParams } from 'react-router-dom';
import { userSchema, usersSchema, type User } from '@luch/contracts';
import { useAuth } from '../auth/AuthContext';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState, EmptyState } from '../components/States';

export function UserSummary({ user }: { user: User }) {
  return (
    <div className="profile-summary">
      <h2>{user.name}</h2>
      <p>{user.email}</p>
      <div className="profile-badges">
        <span className="badge">
          {user.role === 'student'
            ? 'Ученик'
            : user.role === 'teacher'
              ? 'Преподаватель'
              : 'Суперадмин'}
        </span>
        {user.isDemo && <span className="badge">Демо-аккаунт</span>}
        <span className="badge">
          {user.emailVerified ? 'Почта подтверждена' : 'Почта не подтверждена'}
        </span>
        <span className="badge">
          {user.authenticatorEnabled ? 'Authenticator подключён' : 'Authenticator не подключён'}
        </span>
      </div>
    </div>
  );
}
export function StudentPage() {
  const { session } = useAuth();
  const { state, refresh } = useResource(`/users/${session.user!.id}`, userSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <>
      <p className="eyebrow">Ваше пространство</p>
      <h1>Кабинет ученика</h1>
      <section className="panel">
        <UserSummary user={state.data} />
      </section>
      <EmptyState
        title="Можно готовиться к обучению"
        description="Учебные маршруты и материалы уже доступны. Диагностика, прохождение упражнений и индивидуальный план появятся в следующих обновлениях."
      />
      <div className="next-grid">
        <Link to="/courses">Учебные маршруты →</Link>
        <Link to="/plan">Мой план →</Link>
        <Link to="/schedule">Расписание →</Link>
        <Link to="/progress">Прогресс →</Link>
      </div>
    </>
  );
}
export function TeacherPage() {
  const { session } = useAuth();
  const { state, refresh } = useResource('/teacher/students', usersSchema);
  return (
    <>
      <p className="eyebrow">Рабочее пространство</p>
      <h1>Кабинет преподавателя</h1>
      <section className="panel">
        <UserSummary user={session.user!} />
      </section>
      <section className="panel">
        <h2>Мои ученики</h2>
        {state.status === 'loading' ? (
          <LoadingState />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} retry={refresh} />
        ) : state.data.length ? (
          <ul className="account-list">
            {state.data.map((user) => (
              <li key={user.id}>
                <strong>{user.name}</strong>
                <span>{user.email}</span>
                <Link className="text-link" to={`/teacher/students/${user.id}`}>
                  Открыть карточку →
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Ученики пока не назначены"
            description="Суперадмин может закрепить ученика за вами."
          />
        )}
      </section>
    </>
  );
}
export function TeacherStudentPage() {
  const { id } = useParams();
  const { state, refresh } = useResource(`/users/${id}`, userSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <>
      <h1>Карточка ученика</h1>
      <section className="panel">
        <UserSummary user={state.data} />
        <p>Учебные результаты появятся после начала обучения.</p>
      </section>
      <Link to="/teacher">← Мои ученики</Link>
    </>
  );
}
