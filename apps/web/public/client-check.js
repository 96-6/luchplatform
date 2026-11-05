// Shared by the server's 403 document and the React gate. No third-party requests or storage.
const prefix = '/api/v1/security/client/';
const text = (ru, en) => (document.documentElement.lang === 'en' ? en : ru);
const failure = () =>
  new Error(
    text(
      'Браузер блокирует необходимые функции сайта. Разрешите JavaScript, cookies и ресурсы платформы, затем повторите проверку.',
      'Your browser is blocking required site features. Allow JavaScript, cookies and platform resources, then try again.',
    ),
  );
async function request(path, body, signal) {
  const response = await fetch(prefix + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!response.ok) throw failure();
  const payload = await response.json();
  return payload.data;
}
async function resources(challenge, signal) {
  const script = document.createElement('script');
  const sheet = document.createElement('link');
  const control = document.createElement('div');
  const probe = document.createElement('div');
  control.className = 'luch-client-control';
  probe.className = 'luch-client-probe adsbox adsbygoogle ad-banner';
  control.setAttribute('aria-hidden', 'true');
  probe.setAttribute('aria-hidden', 'true');
  sheet.rel = 'stylesheet';
  sheet.href = prefix + 'probe.css';
  script.src = prefix + 'ads.js?id=' + encodeURIComponent(challenge.id);
  let listener, abort, timer;
  try {
    const proof = new Promise((resolve, reject) => {
      listener = (event) => {
        if (event.detail?.id === challenge.id && /^[a-f0-9]{64}$/.test(event.detail.proof))
          resolve(event.detail.proof);
      };
      abort = () => reject(failure());
      window.addEventListener('luch:client-resource', listener);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, 7000);
      script.onerror = abort;
    });
    const styled = new Promise((resolve, reject) => {
      sheet.onload = resolve;
      sheet.onerror = () => reject(failure());
    });
    document.head.append(sheet);
    document.body.append(control, probe);
    document.head.append(script);
    const [value] = await Promise.all([proof, styled]);
    if (signal.aborted) throw failure();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        rect.width >= 4 &&
        rect.height >= 4 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    };
    return { proof: value, visible: visible(control) && visible(probe) };
  } finally {
    clearTimeout(timer);
    window.removeEventListener('luch:client-resource', listener);
    signal.removeEventListener('abort', abort);
    script.remove();
    sheet.remove();
    control.remove();
    probe.remove();
  }
}
export async function checkClient({ force = false, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 20000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await request(
        'bootstrap' + (force || attempt ? '?force=true' : ''),
        null,
        controller.signal,
      );
      if (!state.challenge) return state;
      let evidence;
      try {
        evidence = await resources(state.challenge, controller.signal);
      } catch {
        evidence = { proof: null, visible: false };
      }
      try {
        await request('verify', { ...state.challenge, ...evidence }, controller.signal);
        // Verify the grant on a separate request: Set-Cookie alone proves nothing.
        const checked = await request('bootstrap', null, controller.signal);
        if (!checked.verified) throw failure();
        return checked;
      } catch (error) {
        if (controller.signal.aborted || attempt === 1) throw error;
      }
    }
    throw failure();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
if (document.body?.hasAttribute('data-client-check')) {
  const button = document.getElementById('client-check-retry');
  const status = document.getElementById('client-check-status');
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    status.textContent = text('Проверяем настройки браузера…', 'Checking browser settings…');
    try {
      await checkClient({ force: true });
      // The location, including invitation and recovery parameters, is never sent to a redirect endpoint.
      location.reload();
    } catch {
      status.textContent = failure().message;
      busy = false;
      button.disabled = false;
    }
  };
  button.addEventListener('click', run);
  void run();
}
