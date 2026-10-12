import { copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
const root = new URL('../', import.meta.url);
try {
  await access(new URL('.env', root));
  console.log('Existing .env preserved.');
} catch {
  await copyFile(new URL('.env.example', root), new URL('.env', root), constants.COPYFILE_EXCL);
  console.log('Created local .env from .env.example.');
}
