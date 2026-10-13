import { z } from 'zod';
import { boundedBody, type ProviderFetch } from './adapters.js';
import type { Reservation } from './budget.js';

export class HeyGenRejected extends Error {
  constructor(readonly code: string) {
    super('HeyGen rejected the request');
  }
}
export class HeyGenAdapter {
  constructor(readonly send: ProviderFetch = fetch) {}
  async json(path: string, credential: string, body?: unknown) {
    const response = await this.send(`https://api.heygen.com/v3/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Api-Key': credential, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(7000),
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500)
        throw new HeyGenRejected(
          response.status === 402 ? 'HEYGEN_CREDITS_EXHAUSTED' : 'HEYGEN_REQUEST_REJECTED',
        );
      throw new Error('HEYGEN_UNAVAILABLE');
    }
    const payload = z
      .object({ data: z.unknown() })
      .parse(JSON.parse((await boundedBody(response, 64 * 1024)).toString('utf8')));
    return payload.data;
  }
  async start(
    r: Reservation,
    script: string,
    avatarId: string,
    voiceId: string,
    language: 'ru' | 'en',
    speed: number,
  ) {
    const data = await this.json('videos', r.credential, {
      type: 'avatar',
      avatar_id: avatarId,
      script,
      voice_id: voiceId,
      title: 'LUCH — учебная реплика',
      resolution: '720p',
      aspect_ratio: '16:9',
      engine: { type: r.provider.model },
      voice_settings: { speed, locale: language === 'ru' ? 'ru-RU' : 'en-US' },
      output_format: 'mp4',
    });
    return z.object({ video_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).parse(data).video_id;
  }
  async status(id: string, credential: string) {
    return z
      .object({
        status: z.enum(['pending', 'processing', 'completed', 'failed']),
        video_url: z.url().optional().nullable(),
        duration: z.number().nonnegative().optional().nullable(),
        failure_code: z.string().optional().nullable(),
      })
      .parse(await this.json(`videos/${encodeURIComponent(id)}`, credential));
  }
  async download(src: string) {
    const url = new URL(src);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['heygen.com', 'heygen.ai', 'amazonaws.com', 'cloudfront.net'].some(
        (domain) => url.hostname === domain || url.hostname.endsWith('.' + domain),
      )
    )
      throw new Error('UNTRUSTED_VIDEO_URL');
    const response = await this.send(url.href, {
      signal: AbortSignal.timeout(7000),
      redirect: 'error',
    });
    if (!response.headers.get('content-type')?.startsWith('video/mp4'))
      throw new Error('INVALID_VIDEO_TYPE');
    const bytes = await boundedBody(response, 32 * 1024 * 1024);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp')
      throw new Error('INVALID_VIDEO');
    return bytes;
  }
}
