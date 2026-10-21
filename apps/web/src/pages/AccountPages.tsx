import { t } from '../i18n';
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
            ? t('Ученик')
            : user.role === 'teacher'
              ? t('Преподаватель')
              : user.role === 'admin'
                ? t('Администратор')
                : t('Суперадмин')}
        </span>
        <span className="badge">
          {user.passwordConfigured ? t('Пароль установлен') : t('Пароль ещё не установлен')}
        </span>
        {user.isDemo && <span className="badge">{t('Демо-аккаунт')}</span>}
        <span className="badge">
          {user.emailVerified ? t('Почта подтверждена') : t('Почта не подтверждена')}
        </span>
        <span className="badge">
          {user.authenticatorEnabled
            ? t('Authenticator подключён')
            : t('Authenticator не подключён')}
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
      <h1>{t('Кабинет преподавателя')}</h1>
      <p className="button-row">
        <Link to="/schedule">{t('Расписание и видеозанятия')}</Link>
        <Link to="/plan">{t('Планы учеников')}</Link>
        <Link to="/progress">{t('Учебные отчёты')}</Link>
        <Link to="/learning">{t('Прохождения и ответы')}</Link>
      </p>
      <UpcomingMeetings />
      <section className="panel">
        <UserSummary user={session.user!} />
      </section>
      <section className="panel">
        <h2>{t('Мои ученики')}</h2>
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
                  {t('Открыть карточку →')}
                </Link>
                <Link to={`/progress?userId=${user.id}`}>{t('Учебный отчёт →')}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title={t('Ученики пока не назначены')}
            description={t('Суперадмин может закрепить ученика за вами.')}
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
      <h1>{t('Карточка ученика')}</h1>
      <section className="panel">
        <UserSummary user={state.data} />
        <p>{t('Ниже доступны сохранённые прохождения и ответы ученика.')}</p>
        <Link className="button-link" to={`/progress?userId=${id}`}>
          {t('Открыть учебный отчёт →')}
        </Link>
      </section>
      <p>
        <Link to={`/assistant?userId=${id}`}>{t('Персонаж и переписка помощника →')}</Link>
      </p>
      <RecentAttempts userId={id!} />
      <TeacherUpdates userId={id!} compact />
      <RunList userId={id} />
      <PlanOverview userId={id!} />
      <ProfileOverview userId={id!} />
      <DiagnosticHistory userId={id!} />
      <SkillStates userId={id!} />
      <Link to={session.dashboardPath ?? '/teacher'}>{t('← Кабинет')}</Link>
    </>
  );
}
