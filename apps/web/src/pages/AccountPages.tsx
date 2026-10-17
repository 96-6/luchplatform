import { UpcomingMeetings } from './meetings/shared';
import { RecentAttempts, TeacherUpdates } from './TeacherPages';
import { Link, useParams } from 'react-router-dom';
import { userSchema, usersSchema, type User } from '@luch/contracts';
import { useAuth } from '../auth/AuthContext';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState, EmptyState } from '../components/States';
import { RunList } from './EnginePages';
import { ProfileOverview, DiagnosticHistory } from './DiagnosticPages';
import { PlanOverview } from './PlanPages';
import { SkillStates } from './AdaptationViews';

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
              : user.role === 'admin'
                ? 'Администратор'
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
export function TeacherPage() {
  const { session } = useAuth();
  const { state, refresh } = useResource('/teacher/students', usersSchema);
  return (
    <>
      <p className="eyebrow">Рабочее пространство</p>
      <h1>Кабинет преподавателя</h1>
      <p className="button-row">
        <Link to="/schedule">Расписание и видеозанятия</Link>
        <Link to="/plan">Планы учеников</Link>
        <Link to="/progress">Учебные отчёты</Link>
        <Link to="/learning">Прохождения и ответы</Link>
      </p>
      <UpcomingMeetings />
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
                <Link to={`/progress?userId=${user.id}`}>Учебный отчёт →</Link>
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
  const { session } = useAuth();
  const { id } = useParams();
  const { state, refresh } = useResource(`/users/${id}`, userSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <>
      <h1>Карточка ученика</h1>
      <section className="panel">
        <UserSummary user={state.data} />
        <p>Ниже доступны сохранённые прохождения и ответы ученика.</p>
        <Link className="button-link" to={`/progress?userId=${id}`}>
          Открыть учебный отчёт →
        </Link>
      </section>
      <p>
        <Link to={`/assistant?userId=${id}`}>Персонаж и переписка помощника →</Link>
      </p>
      <RecentAttempts userId={id!} />
      <TeacherUpdates userId={id!} compact />
      <RunList userId={id} />
      <PlanOverview userId={id!} />
      <ProfileOverview userId={id!} />
      <DiagnosticHistory userId={id!} />
      <SkillStates userId={id!} />
      <Link to={session.dashboardPath ?? '/teacher'}>← Кабинет</Link>
    </>
  );
}
