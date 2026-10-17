import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { localeCatalogs } from '../packages/contracts/dist/localization.js';
const missing = new Set();
const normalize = (value) => value.replace(/\s+/g, ' ').trim();
async function scan(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = resolve(folder, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.tsx?$/.test(file)) {
      const source = ts.createSourceFile(
        file,
        await readFile(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node) {
        if (ts.isJsxText(node) && /[А-Яа-яЁё]/.test(node.text))
          missing.add('Unlocalized JSX: ' + normalize(node.text));
        if (
          ts.isJsxAttribute(node) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer) &&
          /[А-Яа-яЁё]/.test(node.initializer.text)
        )
          missing.add('Unlocalized attribute: ' + node.initializer.text);
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ['t', 'tr'].includes(node.expression.text)
        ) {
          const text = node.arguments[0];
          if (
            text &&
            ts.isStringLiteralLike(text) &&
            /[А-Яа-яЁё]/.test(text.text) &&
            !Object.hasOwn(localeCatalogs.en, normalize(text.text))
          )
            missing.add(normalize(text.text));
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
await scan(resolve('apps/web/src'));
for (const [source, value] of Object.entries(localeCatalogs.en)) {
  const placeholders = (text) =>
    [...text.matchAll(/\{(\d+)\}/g)]
      .map((m) => m[1])
      .sort()
      .join(',');
  if (placeholders(source) !== placeholders(value))
    missing.add('Interpolation mismatch: ' + source);
}
if (missing.size) throw Error('Missing English UI translations:\n' + [...missing].join('\n'));
console.log(
  `English UI catalog: ${Object.keys(localeCatalogs.en).length} entries, source coverage and interpolation checked.`,
);
