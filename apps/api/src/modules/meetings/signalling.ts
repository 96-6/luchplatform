import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TokenVerifier } from 'livekit-server-sdk';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { Settings } from '../../config.js';
import { AppError } from '../../errors.js';
import type { Actor, AuthService } from '../auth/service.js';
import type { MeetingsService } from './service.js';

const maxBuffered = 1024 * 1024;
type Context = { actor: Actor; identity: string; room: string; token: string };

// LiveKit OSS does not revoke participant JWTs. Only this authenticated gateway is public;
// the SFU's signalling/API port stays private. Media still travels directly through WebRTC.
export async function registerMeetingSignalling(
  app: FastifyInstance,
  auth: AuthService,
  service: MeetingsService,
  settings: Settings,
) {
  const contexts = new WeakMap<FastifyRequest, Context>(),
    upstreams = new Set<WebSocket>(),
    verifier = new TokenVerifier(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET),
    origin = new URL(settings.APP_URL).origin;

  async function authorize(request: FastifyRequest) {
    const actor = await auth.requireActor(request);
    if (request.headers.origin && request.headers.origin !== origin)
      throw new AppError(403, 'ORIGIN_REJECTED', 'Подключение с этого адреса не разрешено.');
    if (request.headers.upgrade && request.headers.origin !== origin)
      throw new AppError(403, 'ORIGIN_REJECTED', 'Подключение с этого адреса не разрешено.');
    const query = request.query as Record<string, unknown>;
    if (typeof query.access_token !== 'string' || query.access_token.length > 8192)
      throw new AppError(401, 'VIDEO_TOKEN_INVALID', 'Обновите подключение к встрече.');
    let identity: string, room: string;
    try {
      const claims = await verifier.verify(query.access_token, 0);
      identity = z.uuid().parse(claims.sub);
      room = z.string().min(1).max(200).parse(claims.video?.room);
      if (!claims.video?.roomJoin) throw new Error('Not a participant token');
    } catch {
      throw new AppError(401, 'VIDEO_TOKEN_INVALID', 'Обновите подключение к встрече.');
    }
    const token = await service.signal(actor, identity, room);
    contexts.set(request, { actor, identity, room, token });
  }

  for (const path of ['/rtc', '/rtc/v1']) {
    app.get(`/api/v1/video${path}/validate`, { preValidation: authorize }, (_r, reply) =>
      reply.type('text/plain').send('ok'),
    );
    app.get(
      `/api/v1/video${path}`,
      { websocket: true, preValidation: authorize },
      (client, request) => {
        const context = contexts.get(request)!;
        const target = new URL(settings.LIVEKIT_WS_URL);
        target.pathname = `${target.pathname.replace(/\/$/, '')}${path}`;
        target.search = new URL(request.url, origin).search;
        // Do not trust old grants on reconnect: mint the current persisted media policy.
        target.searchParams.set('access_token', context.token);
        const upstream = new WebSocket(target, {
          handshakeTimeout: 5000,
          maxPayload: 256 * 1024,
          perMessageDeflate: false,
          followRedirects: false,
        });
        upstreams.add(upstream);
        let ready = false,
          closed = false,
          buffered = 0;
        const pending: { target: WebSocket; data: RawData; binary: boolean }[] = [];
        const close = () => {
          if (closed) return;
          closed = true;
          pending.length = 0;
          upstreams.delete(upstream);
          if (client.readyState === WebSocket.OPEN) client.close(1008, 'Connection ended');
          if (upstream.readyState === WebSocket.OPEN) upstream.close();
          else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
        };
        const send = (socket: WebSocket, data: RawData, binary: boolean) => {
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > maxBuffered) {
            close();
            return;
          }
          socket.send(data, { binary }, (error) => {
            if (error) close();
          });
        };
        const forward = (socket: WebSocket, data: RawData, binary: boolean) => {
          if (closed) return;
          if (ready) return send(socket, data, binary);
          buffered += Array.isArray(data)
            ? data.reduce((n, part) => n + part.byteLength, 0)
            : data.byteLength;
          if (buffered > maxBuffered) return close();
          pending.push({ target: socket, data, binary });
        };
        // Attach listeners synchronously, including while the upstream handshake is pending.
        client.on('message', (data, binary) => forward(upstream, data, binary));
        upstream.on('message', (data, binary) => forward(client, data, binary));
        client.on('close', close);
        client.on('error', close);
        upstream.on('close', close);
        upstream.on('error', close);
        upstream.on('unexpected-response', (_request, response) => {
          response.destroy();
          close();
        });
        upstream.on('open', () => {
          // Close the race where a kick/permission change committed during the SFU handshake.
          void service
            .signal(context.actor, context.identity, context.room, true)
            .then(() => {
              if (closed) return;
              ready = true;
              for (const item of pending) send(item.target, item.data, item.binary);
              pending.length = 0;
            })
            .catch(close);
        });
      },
    );
  }
  app.addHook('preClose', async () => {
    for (const socket of upstreams) socket.terminate();
    upstreams.clear();
  });
}
