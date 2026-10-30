import {
  browserAssessmentSchema,
  browserBootstrapSchema,
  browserSnapshotSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import { api } from '../lib/api';
type Snapshot = z.infer<typeof browserSnapshotSchema>;
type Hints = NonNullable<Snapshot['hints']> & {
  getHighEntropyValues?: (keys: string[]) => Promise<{ fullVersionList?: Hints['brands'] }>;
};
async function snapshot(): Promise<Snapshot> {
  const data = (navigator as Navigator & { userAgentData?: Hints }).userAgentData;
  let hints: Snapshot['hints'] = null;
  if (data) {
    let brands = data.brands;
    try {
      const full = await Promise.race([
        data.getHighEntropyValues?.(['fullVersionList']),
        new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
      ]);
      brands = full?.fullVersionList ?? brands;
    } catch {
      /* Privacy restrictions retain the low-entropy hints. */
    }
    hints = {
      brands: Array.from(brands).slice(0, 12),
      platform: data.platform,
      mobile: data.mobile,
    };
  }
  return {
    userAgent: navigator.userAgent.slice(0, 1024),
    platform: navigator.platform.slice(0, 80),
    hints,
  };
}
async function workerSnapshot(): Promise<Snapshot | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker('/browser-check-worker.js');
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value: Snapshot | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 4000);
    worker.onerror = () => finish(null);
    worker.onmessage = (event) => {
      const parsed = browserSnapshotSchema.safeParse(event.data);
      finish(parsed.success ? parsed.data : null);
    };
    worker.postMessage({});
  });
}
let pending: Promise<z.infer<typeof browserAssessmentSchema>> | null = null;
export function checkBrowser(force = false) {
  // React StrictMode must not race two first-use cookies and two different challenges.
  pending ??= (async () => {
    const boot = await api(
      `/security/browser/bootstrap${force ? '?force=true' : ''}`,
      browserBootstrapSchema,
    );
    if (boot.decision) return { decision: boot.decision, noticeToken: boot.noticeToken };
    const [page, worker] = await Promise.all([snapshot(), workerSnapshot()]);
    return api('/security/browser/assess', browserAssessmentSchema, {
      body: {
        challengeId: boot.challenge!.id,
        nonce: boot.challenge!.nonce,
        page,
        worker,
        features: {
          fetch: typeof fetch === 'function',
          abortController: typeof AbortController === 'function',
          websocket: typeof WebSocket === 'function',
          crypto: Boolean(globalThis.crypto?.subtle),
          textEncoder: typeof TextEncoder === 'function',
          worker: Boolean(worker),
        },
      },
    });
  })().finally(() => {
    pending = null;
  });
  return pending;
}
