import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { contentPackageSchema } from '@luch/contracts';

// JSON Schema covers structure; cross-entity rules are enforced by content:validate/import.
const schema = z.toJSONSchema(contentPackageSchema, { target: 'draft-2020-12' });
await mkdir(new URL('../content/schema/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../content/schema/luch-content-v1.schema.json', import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
console.log('Generated luch-content format v1 JSON Schema.');
