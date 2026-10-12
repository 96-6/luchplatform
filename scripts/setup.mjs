import { copyFile, access, readFile, writeFile, chmod } from 'node:fs/promises';
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
await writeFile(destination, content);
await chmod(destination, 0o600);
console.log(`Environment ${filename} prepared; existing values preserved.`);
