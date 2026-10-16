import { copyFile, access, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
const root = new URL('../', import.meta.url);
const filename = process.argv.includes('--compose') ? '.env.compose' : '.env';
const destination = new URL(filename, root);
try {
  await access(destination);
} catch {
  await copyFile(new URL(`${filename}.example`, root), destination, constants.COPYFILE_EXCL);
}
let content = await readFile(destination, 'utf8');
const example = await readFile(new URL(`${filename}.example`, root), 'utf8');
for (const line of example.split('\n')) {
  const match = /^([A-Z_]+)=/.exec(line);
  if (match && !new RegExp(`^${match[1]}=`, 'm').test(content)) content += `\n${line}`;
}
if (!/^AUTH_ENCRYPTION_KEY=.+$/m.test(content)) {
  const value = `AUTH_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`;
  content = /^AUTH_ENCRYPTION_KEY=.*$/m.test(content)
    ? content.replace(/^AUTH_ENCRYPTION_KEY=.*$/m, value)
    : `${content}\n${value}\n`;
}
if (process.argv.includes('--video')) {
  const get = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(content)?.[1]?.trim() ?? '';
  const set = (name, value) => {
    content = new RegExp(`^${name}=`, 'm').test(content)
      ? content.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`)
      : `${content}\n${name}=${value}\n`;
  };
  if (!get('LIVEKIT_API_KEY')) set('LIVEKIT_API_KEY', `luch_${randomBytes(12).toString('hex')}`);
  if (!get('LIVEKIT_API_SECRET')) set('LIVEKIT_API_SECRET', randomBytes(32).toString('hex'));
  if (!get('LIVEKIT_URL'))
    set(
      'LIVEKIT_URL',
      process.argv.includes('--compose') ? 'http://livekit:7880' : 'http://127.0.0.1:7880',
    );
  if (!get('LIVEKIT_WS_URL'))
    set('LIVEKIT_WS_URL', compose ? 'ws://livekit:7880' : 'ws://127.0.0.1:7880');
  await mkdir(new URL('data/', root), { recursive: true });
  await writeFile(
    new URL('data/livekit.yaml', root),
    `port: 7880\nbind_addresses: ["0.0.0.0"]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  node_ip: ${JSON.stringify(get('LIVEKIT_NODE_IP') || '127.0.0.1')}\n  use_external_ip: false\n  enable_loopback_candidate: true\nroom:\n  auto_create: false\n  enable_remote_unmute: false\nkeys:\n  ${JSON.stringify(get('LIVEKIT_API_KEY'))}: ${JSON.stringify(get('LIVEKIT_API_SECRET'))}\nlogging:\n  level: warn\n`,
    { mode: 0o600 },
  );
}
await writeFile(destination, content);
await chmod(destination, 0o600);
console.log(`Environment ${filename} prepared; existing values preserved.`);
