import { spawn } from 'node:child_process';
const children = new Set();
export function trackChild(child) {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
export function abortCommands() {
  for (const child of children)
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
}
export function redactor(env = process.env) {
  const secrets = Object.entries(env)
    .filter(([k, v]) => v && /KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(k))
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  for (const value of Object.values(env))
    if (value)
      try {
        const u = new URL(value);
        if (u.password) secrets.push(decodeURIComponent(u.password));
      } catch {}
  return (text) => {
    let out = String(text)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[hidden]@');
    for (const secret of secrets) out = out.replaceAll(secret, '[hidden]');
    return out.slice(0, 1500);
  };
}
export function buildEnvironment() {
  const result = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'npm_config_cache',
    'NPM_CONFIG_CACHE',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'NPM_CONFIG_CAFILE',
    'npm_config_cafile',
    'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTP_PROXY',
    'NPM_CONFIG_HTTPS_PROXY',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'SYSTEMROOT',
    'COMSPEC',
  ])
    if (process.env[key]) result[key] = process.env[key];
  return { ...result, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', CI: 'true' };
}
export function command(
  executable,
  args,
  {
    cwd,
    env = process.env,
    log = () => {},
    timeoutMs = 15 * 60 * 1000,
    capture = false,
    quiet = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = trackChild(
      spawn(executable, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
      }),
    );
    let output = '',
      line = '',
      ended = false;
    const kill = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const timeout = setTimeout(() => {
      kill();
      finish(Error('Command timed out'));
    }, timeoutMs);
    function finish(error) {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      if (line && !quiet) log(line);
      error ? reject(error) : resolve(output);
    }
    const receive = (bytes) => {
      const value = bytes.toString();
      if (capture) {
        output += value;
        if (output.length > 8 * 1024 * 1024) {
          kill();
          finish(Error('Command output too large'));
          return;
        }
      }
      if (!quiet) {
        line += value;
        const parts = line.split(/\r?\n/);
        line = parts.pop();
        for (const part of parts) if (part) log(part);
        if (line.length > 8000) {
          log(line.slice(0, 1500));
          line = '';
        }
      }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', () => finish(Error('Command could not start')));
    child.once('close', (code) => finish(code === 0 ? null : Error('Command failed')));
  });
}
