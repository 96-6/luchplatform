import { messageSchema, type NetworkEvidence } from '@luch/contracts';
import { api } from '../lib/api';

async function resource(target: { id: 'youtube' | 'telegram' | 'whatsapp'; url: string }) {
  return new Promise<{ id: typeof target.id; loaded: boolean } | null>((resolve) => {
    const image = new Image();
    let done = false;
    const finish = (loaded: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(loaded ? { id: target.id, loaded: true } : null);
    };
    const timer = setTimeout(() => finish(false), 2000);
    image.referrerPolicy = 'no-referrer';
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = target.url;
  });
}
async function publicRtcIp(stunUrls: string[]): Promise<string | undefined> {
  if (!stunUrls.length || !window.RTCPeerConnection) return undefined;
  return new Promise((resolve) => {
    const connection = new RTCPeerConnection({ iceServers: [{ urls: stunUrls }] });
    let done = false;
    const finish = (value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), 2000);
    connection.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate;
      if (candidate?.includes(' typ srflx ')) finish(candidate.split(' ')[4]);
    };
    connection.createDataChannel('check');
    void connection
      .createOffer()
      .then((offer) => connection.setLocalDescription(offer))
      .catch(() => finish());
  });
}
export async function collectNetworkEvidence(
  targets: Parameters<typeof resource>[0][],
  stunUrls: string[],
): Promise<NetworkEvidence> {
  const [results, webrtcIp] = await Promise.all([
    Promise.all(targets.map(resource)),
    publicRtcIp(stunUrls),
  ]);
  const latencyMs: number[] = [];
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    try {
      await api('/security/ping', messageSchema);
      latencyMs.push(performance.now() - start);
    } catch {}
  }
  const browser = navigator as Navigator & { connection?: { saveData?: boolean } };
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    resourceResults: results.filter((value): value is NonNullable<typeof value> => value !== null),
    latencyMs,
    turboMode: browser.connection?.saveData === true,
    jsProxyHint: new URL(document.baseURI).origin !== window.location.origin,
    ...(webrtcIp ? { webrtcIp } : {}),
  };
}
