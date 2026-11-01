import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInfoSchema, type BuildInfo } from '@luch/contracts';
import { projectRoot, type Settings } from '../../config.js';

export async function installedBuild(settings: Settings): Promise<BuildInfo> {
  if (settings.APP_ENV === 'development' && !settings.SERVE_WEB) {
    const inspect = await import(
      pathToFileURL(resolve(projectRoot, 'scripts/build-info.mjs')).href
    );
    const source = await inspect.inspectSource(projectRoot);
    return buildInfoSchema.parse({
      version: 'development',
      ...source,
      builtAt: null,
      kind: 'development',
    });
  }
  try {
    return buildInfoSchema.parse(
      JSON.parse(await readFile(resolve(projectRoot, 'build-info.json'), 'utf8')),
    );
  } catch {
    return {
      version: 'unknown',
      commit: null,
      fingerprint: null,
      builtAt: null,
      modified: false,
      kind: 'unknown',
    };
  }
}
