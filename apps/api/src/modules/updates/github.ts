import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sourceCommitSchema } from '@luch/contracts';

export type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;
const endpoint = 'https://api.github.com/repos/96-6/luchplatform/';
export class GitHubUpdates {
  constructor(readonly fetcher: UpdateFetch = fetch) {}
  async json(path: string) {
    const response = await this.fetcher(endpoint + path, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'LUCH-version-check',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) throw Error('GitHub unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw Error('GitHub response missing');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 3 * 1024 * 1024) {
        await reader.cancel();
        throw Error('GitHub response too large');
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  async latest() {
    const branch = z
      .object({
        commit: z.object({
          sha: sourceCommitSchema,
          commit: z.object({
            tree: z.object({ sha: sourceCommitSchema }),
            committer: z.object({ date: z.iso.datetime() }),
          }),
        }),
      })
      .parse(await this.json('branches/main'));
    const tree = z
      .object({
        truncated: z.boolean(),
        tree: z.array(
          z.object({ path: z.string().max(1000), type: z.string(), sha: sourceCommitSchema }),
        ),
      })
      .parse(await this.json(`git/trees/${branch.commit.commit.tree.sha}?recursive=1`));
    if (tree.truncated) throw Error('Incomplete source tree');
    const fingerprint = createHash('sha256')
      .update(
        tree.tree
          .filter((e) => e.type === 'blob' && e.path !== 'source-version.json')
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((e) => `${e.path}\0${e.sha}\n`)
          .join(''),
      )
      .digest('hex');
    return {
      commit: branch.commit.sha,
      fingerprint,
      committedAt: branch.commit.commit.committer.date,
    };
  }
  async comparison(from: string, to: string) {
    if (!sourceCommitSchema.safeParse(from).success || !sourceCommitSchema.safeParse(to).success)
      return 'diverged';
    return z
      .object({ status: z.enum(['ahead', 'behind', 'identical', 'diverged']) })
      .parse(await this.json(`compare/${from}...${to}`)).status;
  }
}
