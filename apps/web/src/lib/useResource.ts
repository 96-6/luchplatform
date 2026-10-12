import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import { api } from './api';

export type Resource<T> =
  { status: 'loading' } | { status: 'error'; error: Error } | { status: 'ready'; data: T };
export function useResource<T extends z.ZodType>(path: string, schema: T) {
  const [state, setState] = useState<Resource<z.infer<T>>>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void api(path, schema, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data });
      },
      (error: Error) => {
        if (!controller.signal.aborted) setState({ status: 'error', error });
      },
    );
    return () => controller.abort();
  }, [path, schema, revision]);
  return { state, refresh };
}
