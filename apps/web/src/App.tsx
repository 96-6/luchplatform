import { AttemptReviewPage, TeacherFeedbackPage } from './pages/TeacherPages';
import { Route, Routes, Link, Navigate } from 'react-router-dom';
import { AssistantPage } from './pages/AssistantPage';
import { systemSchema } from '@luch/contracts';
import { Layout } from './components/Layout';
import { LoadingState, ErrorState } from './components/States';
import { HomePage } from './pages/HomePage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { SystemPage } from './pages/SystemPage';
import { useResource } from './lib/useResource';
import { Protected } from './auth/AuthContext';
import {
  LoginPage,
  RegisterPage,
  VerifyEmailPage,
  AuthenticatorPage,
  DemoMailPage,
} from './pages/AuthPages';
import { TeacherPage, TeacherStudentPage } from './pages/AccountPages';
import { StudentPage } from './pages/StudentPage';
import { AdminPage } from './pages/AdminPage';
import { EngineHistoryPage, ExerciseRunPage } from './pages/EnginePages';
import { OnboardingPage, DiagnosticResultPage } from './pages/DiagnosticPages';
import { PlansPage, PlanDetailPage } from './pages/PlanPages';
import { OperationsPage, ProviderPage } from './pages/ProviderPages';
import {
  AdminContentPage,
  CourseCatalogPage,
  CourseRoutePage,
  LessonPreviewPage,
} from './pages/ContentPages';

export function App() {
  const { state, refresh } = useResource('/system', systemSchema);
  const devTools = state.status === 'ready' && state.data.devToolsEnabled;
  return (
    <Layout devTools={devTools}>
      {state.status === 'loading' ? (
        <LoadingState text="Подключаемся к платформе…" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <Routes>
          <Route
            path="/learning/attempts/:id"
            element={
              <Protected>
                <AttemptReviewPage />
              </Protected>
            }
          />
          <Route
            path="/feedback"
            element={
              <Protected>
                <TeacherFeedbackPage />
              </Protected>
            }
          />
          <Route path="/" element={<HomePage />} />
          <Route
            path="/onboarding"
            element={
              <Protected>
                <OnboardingPage />
              </Protected>
            }
          />
          <Route
            path="/diagnostics/:id"
            element={
              <Protected>
                <DiagnosticResultPage />
              </Protected>
            }
          />
          <Route
            path="/learning"
            element={
              <Protected>
                <EngineHistoryPage />
              </Protected>
            }
          />
          <Route
            path="/learning/runs/:id"
            element={
              <Protected>
                <ExerciseRunPage />
              </Protected>
            }
          />
          <Route
            path="/admin/learning"
            element={
              <Protected role="superadmin">
                <EngineHistoryPage />
              </Protected>
            }
          />
          <Route
            path="/courses"
            element={
              <Protected>
                <CourseCatalogPage />
              </Protected>
            }
          />
          <Route
            path="/courses/:packageId/:routeId"
            element={
              <Protected>
                <CourseRoutePage />
              </Protected>
            }
          />
          <Route
            path="/courses/:packageId/:routeId/lessons/:lessonId"
            element={
              <Protected>
                <LessonPreviewPage />
              </Protected>
            }
          />
          <Route
            path="/admin/content"
            element={
              <Protected role="superadmin">
                <AdminContentPage />
              </Protected>
            }
          />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/operations"
            element={
              <Protected roles={['admin', 'superadmin']}>
                <OperationsPage />
              </Protected>
            }
          />
          <Route
            path="/admin/providers"
            element={
              <Protected roles={['admin', 'superadmin']}>
                <ProviderPage />
              </Protected>
            }
          />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/authenticator" element={<AuthenticatorPage />} />
          <Route path="/demo-mail" element={<DemoMailPage />} />
          <Route
            path="/student"
            element={
              <Protected role="student">
                <StudentPage />
              </Protected>
            }
          />
          <Route
            path="/admin"
            element={
              <Protected role="superadmin">
                <AdminPage />
              </Protected>
            }
          />
          <Route path="/network-check" element={<Navigate to="/" replace />} />
          <Route
            path="/plan"
            element={
              <Protected>
                <PlansPage />
              </Protected>
            }
          />
          <Route
            path="/plan/:id"
            element={
              <Protected>
                <PlanDetailPage />
              </Protected>
            }
          />
          <Route
            path="/assistant"
            element={
              <Protected>
                <AssistantPage />
              </Protected>
            }
          />
          <Route
            path="/schedule"
            element={
              <Protected>
                <PlaceholderPage
                  title="Расписание"
                  description="Здесь появятся назначенные занятия и ссылки на видеокомнаты."
                />
              </Protected>
            }
          />
          <Route
            path="/progress"
            element={
              <Protected>
                <PlaceholderPage
                  title="Учебный отчёт"
                  description="Полный учебный отчёт пока недоступен. Краткий прогресс показан в кабинете, а сохранённые ответы доступны в разделе «Обучение»."
                />
              </Protected>
            }
          />
          <Route
            path="/teacher"
            element={
              <Protected role="teacher">
                <TeacherPage />
              </Protected>
            }
          />
          <Route
            path="/teacher/students/:id"
            element={
              <Protected roles={['teacher', 'superadmin']}>
                <TeacherStudentPage />
              </Protected>
            }
          />
          <Route path="/system" element={<SystemPage enabled={devTools} />} />
          <Route
            path="*"
            element={
              <>
                <h1>Страница не найдена</h1>
                <Link to="/">Вернуться на главную</Link>
              </>
            }
          />
        </Routes>
      )}
    </Layout>
  );
}
