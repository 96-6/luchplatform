import { integrityAckSchema, integrityStatsSchema, type IntegrityStats } from '@luch/contracts';
import { api } from './api';

export function monitorIntegrity(path: string, turnId: string) {
  let stats: IntegrityStats = integrityStatsSchema.parse({ durationMilliseconds: 0 });
  let stamp = performance.now(),
    hidden = document.hidden,
    enabled = true;
  let last: { x: number; y: number; t: number; dx: number; dy: number } | null = null;
  const queued: { turnId: string; batchId: string; stats: IntegrityStats }[] = [];
  let sending: Promise<void> | null = null;
  const account = () => {
    const now = performance.now(),
      delta = Math.max(0, Math.round(now - stamp));
    stats.durationMilliseconds = Math.min(300000, stats.durationMilliseconds + delta);
    if (hidden)
      stats.hiddenMilliseconds = Math.min(
        stats.durationMilliseconds,
        stats.hiddenMilliseconds + delta,
      );
    stamp = now;
  };
  const inLesson = (event: Event) =>
    event.target instanceof Element && Boolean(event.target.closest('#content'));
  const pointer = (event: PointerEvent) => {
    if (!inLesson(event)) return;
    const now = performance.now();
    if (last && now - last.t < 50) return;
    const kind = event.pointerType;
    if (kind === 'mouse' || kind === 'touch' || kind === 'pen')
      stats.pointerTypes = [
        ...new Set<IntegrityStats['pointerTypes'][number]>([...stats.pointerTypes, kind]),
      ];
    stats.pointerSamples++;
    if (!event.isTrusted) stats.syntheticEvents++;
    if (last) {
      const dx = event.clientX - last.x,
        dy = event.clientY - last.y,
        distance = Math.hypot(dx, dy);
      stats.pointerDistance += Math.round(distance);
      if (distance / Math.max(1, now - last.t) > 3) stats.fastMoves++;
      const dot = dx * last.dx + dy * last.dy,
        denominator = Math.hypot(dx, dy) * Math.hypot(last.dx, last.dy);
      if (denominator && dot / denominator > 0.995) stats.straightMoves++;
      last = { x: event.clientX, y: event.clientY, t: now, dx, dy };
    } else last = { x: event.clientX, y: event.clientY, t: now, dx: 0, dy: 0 };
  };
  const keyboard = (event: KeyboardEvent) => {
    if (!inLesson(event)) return;
    if (['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))
      stats.keyboardNavigation = true;
  };
  const input = (event: Event) => {
    if (inLesson(event)) {
      stats.inputEvents++;
      if (!event.isTrusted) stats.syntheticEvents++;
    }
  };
  const paste = (event: Event) => {
    if (inLesson(event)) stats.pasteEvents++;
  };
  const copy = (event: Event) => {
    if (inLesson(event)) stats.copyEvents++;
  };
  const send = async (keepalive = false) => {
    if (sending) {
      await sending;
      return;
    }
    sending = (async () => {
      while (queued.length && enabled) {
        const packet = queued[0]!;
        try {
          const ack = await api(`${path}/integrity`, integrityAckSchema, {
            body: packet,
            keepalive,
          });
          if (!ack.monitored) enabled = false;
          queued.shift();
        } catch {
          break;
        }
      }
    })();
    try {
      await sending;
    } finally {
      sending = null;
    }
  };
  const flush = async (keepalive = false) => {
    if (!enabled) return;
    account();
    const parsed = integrityStatsSchema.safeParse(stats);
    if (parsed.success) {
      queued.push({ turnId, batchId: crypto.randomUUID(), stats: parsed.data });
      if (queued.length > 16) queued.shift();
    }
    stats = integrityStatsSchema.parse({ durationMilliseconds: 0 });
    last = null;
    await send(keepalive);
  };
  const visibility = () => {
    account();
    hidden = document.hidden;
    if (hidden) stats.tabHides++;
    else stats.returns++;
    void flush(true);
  };
  const blur = () => {
    stats.focusLosses++;
    void flush(true);
  };
  const focus = () => {
    stats.returns++;
  };
  const hide = () => {
    void flush(true);
  };
  document.addEventListener('pointermove', pointer, { passive: true });
  document.addEventListener('keydown', keyboard);
  document.addEventListener('input', input);
  document.addEventListener('paste', paste);
  document.addEventListener('copy', copy);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', blur);
  window.addEventListener('focus', focus);
  window.addEventListener('pagehide', hide);
  const timer = setInterval(() => void flush(), 15000);
  return {
    flush,
    dispose: () => {
      clearInterval(timer);
      document.removeEventListener('pointermove', pointer);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('input', input);
      document.removeEventListener('paste', paste);
      document.removeEventListener('copy', copy);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pagehide', hide);
      void flush(true);
    },
  };
}
