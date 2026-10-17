import { t } from '../i18n';
import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="fatal" role="alert">
          <h1>{t('Не удалось открыть страницу')}</h1>
          <p>{t('Обновите страницу, чтобы попробовать ещё раз.')}</p>
          <button onClick={() => window.location.reload()}>{t('Обновить страницу')}</button>
        </main>
      );
    return this.props.children;
  }
}
