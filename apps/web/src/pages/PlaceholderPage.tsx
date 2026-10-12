import { Link } from 'react-router-dom';
import { EmptyState } from '../components/States';
export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <>
      <p className="eyebrow">Ваше пространство</p>
      <h1>{title}</h1>
      <EmptyState title="Раздел готовится" description={description} />
      <Link className="text-link" to="/">
        Вернуться на главную →
      </Link>
    </>
  );
}
