import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../../config.js';
import type { Database } from '../../db/database.js';
import { ContentService } from './service.js';

export async function seedDemoContent(database: Database, actorId?: string) {
  const file = resolve(projectRoot, 'content/demo/luch-demo.json');
  return new ContentService(database).import(JSON.parse(await readFile(file, 'utf8')), actorId);
}
