import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { Settings } from '../../config.js';
import { AppError } from '../../errors.js';
export type MediaPolicy = { audioAllowed: boolean; videoAllowed: boolean; screenAllowed: boolean };
export type RtcPeer = {
  identity: string;
  tracks: {
    sid: string;
    source: 'microphone' | 'camera' | 'screen' | 'screen_audio' | 'other';
    muted: boolean;
  }[];
};
export interface MeetingVideo {
  readonly configured: boolean;
  readonly browserUrl: string;
  ensureRoom(name: string): Promise<void>;
  participants(name: string): Promise<RtcPeer[]>;
  permissions(name: string, identity: string, policy: MediaPolicy): Promise<void>;
  remove(name: string, identity: string): Promise<void>;
  close(name: string): Promise<void>;
  token(name: string, identity: string, displayName: string, policy: MediaPolicy): Promise<string>;
}
export const videoUnavailable = () =>
  new AppError(503, 'VIDEO_UNAVAILABLE', 'Видеосвязь временно недоступна. Повторите попытку.');
const missing = (e: unknown) =>
  Boolean(e && typeof e === 'object' && 'code' in e && e.code === 'not_found');
function sources(p: MediaPolicy) {
  return [
    ...(p.audioAllowed ? [TrackSource.MICROPHONE] : []),
    ...(p.videoAllowed ? [TrackSource.CAMERA] : []),
    ...(p.screenAllowed
      ? [TrackSource.SCREEN_SHARE, ...(p.audioAllowed ? [TrackSource.SCREEN_SHARE_AUDIO] : [])]
      : []),
  ];
}
export class LiveKitVideo implements MeetingVideo {
  readonly configured: boolean;
  readonly browserUrl: string;
  private client: RoomServiceClient;
  constructor(private settings: Settings) {
    this.configured = Boolean(settings.LIVEKIT_URL && settings.LIVEKIT_API_SECRET);
    this.browserUrl = settings.LIVEKIT_WS_URL;
    this.client = new RoomServiceClient(
      settings.LIVEKIT_URL || 'http://127.0.0.1:7880',
      settings.LIVEKIT_API_KEY,
      settings.LIVEKIT_API_SECRET,
      { requestTimeout: 5 },
    );
  }
  private async call<T>(f: () => Promise<T>, notFound?: () => T): Promise<T> {
    if (!this.configured)
      throw new AppError(
        503,
        'VIDEO_NOT_CONFIGURED',
        'Видеосвязь пока не подключена. Обратитесь к администратору.',
      );
    try {
      return await f();
    } catch (e) {
      if (notFound && missing(e)) return notFound();
      throw videoUnavailable();
    }
  }
  async ensureRoom(name: string) {
    await this.call(() =>
      this.client.createRoom({
        name,
        maxParticipants: 64,
        emptyTimeout: 600,
        departureTimeout: 120,
      }),
    );
  }
  async participants(name: string) {
    return this.call(
      async () =>
        (await this.client.listParticipants(name)).map((p) => ({
          identity: p.identity,
          tracks: p.tracks.map((t) => ({
            sid: t.sid,
            source:
              t.source === TrackSource.MICROPHONE
                ? ('microphone' as const)
                : t.source === TrackSource.CAMERA
                  ? ('camera' as const)
                  : t.source === TrackSource.SCREEN_SHARE
                    ? ('screen' as const)
                    : t.source === TrackSource.SCREEN_SHARE_AUDIO
                      ? ('screen_audio' as const)
                      : ('other' as const),
            muted: t.muted,
          })),
        })),
      () => [],
    );
  }
  async permissions(name: string, identity: string, p: MediaPolicy) {
    await this.call(
      async () => {
        const peer = (await this.client.listParticipants(name)).find(
          (x) => x.identity === identity,
        );
        if (!peer) return;
        await this.client.updateParticipant(name, identity, {
          permission: {
            canSubscribe: true,
            canPublish: sources(p).length > 0,
            canPublishSources: sources(p),
            canPublishData: false,
            canUpdateMetadata: false,
          },
        });
        for (const t of peer.tracks) {
          if (!sources(p).includes(t.source))
            await this.client.mutePublishedTrack(name, identity, t.sid, true);
        }
      },
      () => undefined,
    );
  }
  async remove(name: string, identity: string) {
    await this.call(
      () =>
        this.client.removeParticipant(name, identity, {
          revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 86400),
        }),
      () => undefined,
    );
  }
  async close(name: string) {
    await this.call(
      () => this.client.deleteRoom(name),
      () => undefined,
    );
  }
  async token(name: string, identity: string, displayName: string, p: MediaPolicy) {
    if (!this.configured) throw videoUnavailable();
    const token = new AccessToken(this.settings.LIVEKIT_API_KEY, this.settings.LIVEKIT_API_SECRET, {
      identity,
      name: displayName,
      ttl: 120,
    });
    token.addGrant({
      roomJoin: true,
      room: name,
      canSubscribe: true,
      canPublish: sources(p).length > 0,
      canPublishSources: sources(p),
      canPublishData: false,
      canUpdateOwnMetadata: false,
      roomAdmin: false,
    });
    return token.toJwt();
  }
}
