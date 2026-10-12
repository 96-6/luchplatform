import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { CONTENT_MAX_BYTES, contentIdSchema } from '@luch/contracts';
import { loadSettings } from '../../config.js';
import { createDatabase } from '../../db/database.js';
import { assertSchemaCurrent } from '../../db/migrations.js';
import { AppError } from '../../errors.js';
import { ContentService, parseContent, validateContentAssets } from './service.js';
import { seedDemoContent } from './bootstrap.js';

async function run() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--'))
      throw new Error(`Required argument: ${name}`);
    return args[index + 1]!;
  };
  const readPackage = async () => {
    const file = resolve(process.env.INIT_CWD ?? process.cwd(), option('--file'));
    if ((await stat(file)).size > CONTENT_MAX_BYTES) throw new Error('Content file exceeds 2 MiB.');
    return parseContent(JSON.parse(await readFile(file, 'utf8')));
  };
  if (command === 'validate') {
    const manifest = await readPackage();
    await validateContentAssets(manifest);
    console.log(
      `Valid: ${manifest.package.id} v${manifest.package.version}; ${manifest.routes.length} routes, ${manifest.lessons.length} lessons, ${manifest.exercises.length} exercises.`,
    );
    return;
  }
  if (!['seed-demo', 'import', 'export'].includes(command ?? ''))
    throw new Error(
      'Use seed-demo, validate/import --file <JSON>, or export --package <id> --file <new JSON> [--version <n>].',
    );
  const manifest = command === 'import' ? await readPackage() : null;
  const settings = loadSettings();
  const db = await createDatabase(settings);
  try {
    await assertSchemaCurrent(db);
    const service = new ContentService(db);
    if (command === 'export') {
      const id = contentIdSchema.parse(option('--package'));
      const version = args.includes('--version')
        ? z.coerce.number().int().positive().max(1_000_000).parse(option('--version'))
        : undefined;
      const data = await service.export(id, version);
      await writeFile(
        resolve(process.env.INIT_CWD ?? process.cwd(), option('--file')),
        `${JSON.stringify(data, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      console.log(
        `Exported ${id} v${data.package.version}. Media files are referenced separately.`,
      );
    } else {
      const result =
        command === 'seed-demo' ? await seedDemoContent(db) : await service.import(manifest);
      console.log(JSON.stringify(result));
    }
  } finally {
    await db.close();
  }
}
run().catch((error: unknown) => {
  if (error instanceof ZodError)
    console.error(
      JSON.stringify(error.issues.map(({ path, message }) => ({ path: path.join('.'), message }))),
    );
  else if (error instanceof AppError) console.error(`${error.code}: ${error.message}`);
  else
    console.error(
      'Content command failed. Check the command, JSON file, file permissions and database availability.',
    );
  process.exitCode = 1;
});
