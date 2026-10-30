import { request } from 'node:http';

// These operator checks are HTTP clients, without the Fetch Metadata emitted by Node fetch.
export function httpFetch(input, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Smoke HTTP checks require a loopback URL.');
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2)
          responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode;
        resolve(
          new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
            status,
            headers: responseHeaders,
          }),
        );
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('Smoke HTTP request timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}
