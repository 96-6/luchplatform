import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const path = new URL('../data/video-test/', import.meta.url);
await mkdir(path, { recursive: true });
const env = {
  LIVEKIT_URL: 'http://127.0.0.1:7880',
  LIVEKIT_WS_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: `test_${randomBytes(8).toString('hex')}`,
  LIVEKIT_API_SECRET: randomBytes(32).toString('hex'),
};
await writeFile(new URL('environment.json', path), JSON.stringify(env), { mode: 0o600 });
await writeFile(
  new URL('livekit.yaml', path),
  `port: 7880\nbind_addresses: ["127.0.0.1"]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  enable_loopback_candidate: true\nroom:\n  auto_create: false\n  enable_remote_unmute: false\nkeys:\n  ${JSON.stringify(env.LIVEKIT_API_KEY)}: ${JSON.stringify(env.LIVEKIT_API_SECRET)}\nlogging:\n  level: warn\n`,
  { mode: 0o600 },
);
console.log('Isolated LiveKit test configuration prepared.');
