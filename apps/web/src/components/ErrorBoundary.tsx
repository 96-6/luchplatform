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
          <h1>Не удалось открыть страницу</h1>
          <p>Обновите страницу, чтобы попробовать ещё раз.</p>
          <button onClick={() => window.location.reload()}>Обновить страницу</button>
        </main>
      );
    return this.props.children;
  }
}
