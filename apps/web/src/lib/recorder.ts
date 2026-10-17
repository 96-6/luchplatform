import { t } from '../i18n';
// Browser audio is normalized before upload. The server validates PCM frames and duration again.
export function encodePcmWav(parts: Float32Array[], sampleRate: number) {
  const length = parts.reduce((n, part) => n + part.length, 0);
  const source = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    source.set(part, offset);
    offset += part.length;
  }
  const frames = Math.min(30 * 16000, Math.floor((length * 16000) / sampleRate));
  if (frames < 1600)
    throw new Error(t('Запись слишком короткая. Произнесите реплику и попробуйте снова.'));
  const bytes = new Uint8Array(44 + frames * 2),
    view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const at = (i * sampleRate) / 16000,
      left = Math.floor(at),
      fraction = at - left;
    const value = Math.max(
      -1,
      Math.min(
        1,
        source[left]! * (1 - fraction) + (source[Math.min(left + 1, length - 1)] ?? 0) * fraction,
      ),
    );
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export function audioBase64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export class PcmRecorder {
  readonly result: Promise<Uint8Array>;
  private resolve!: (value: Uint8Array) => void;
  private reject!: (reason: Error) => void;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private parts: Float32Array[] = [];
  private cancelled = false;
  private finished = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly maxSeconds: number) {
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    void this.result.catch(() => {});
  }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext)
      throw new Error(t('Запись недоступна в этом браузере. Используйте текстовый ввод.'));
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (this.cancelled) {
        this.cleanup();
        return;
      }
      this.context = new AudioContext();
      if (!this.context.audioWorklet)
        throw new Error(t('Этот браузер не поддерживает запись. Используйте текстовый ввод.'));
      await this.context.resume();
      await this.context.audioWorklet.addModule('/audio/pcm-recorder.js');
      if (this.cancelled) {
        this.cleanup();
        return;
      }
      this.node = new AudioWorkletNode(this.context, 'luch-pcm-recorder', {
        processorOptions: { maxSeconds: this.maxSeconds },
      });
      this.node.port.onmessage = (
        event: MessageEvent<{ samples?: ArrayBuffer; done?: boolean }>,
      ) => {
        if (this.cancelled || this.finished) return;
        if (event.data.samples) this.parts.push(new Float32Array(event.data.samples));
        if (event.data.done) {
          this.finished = true;
          try {
            this.resolve(encodePcmWav(this.parts, this.context!.sampleRate));
          } catch (error) {
            this.reject(error as Error);
          }
          this.cleanup();
        }
      };
      this.node.onprocessorerror = () =>
        this.fail(new Error(t('Запись прервалась. Повторите её или введите текст.')));
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.node);
      this.node.connect(this.context.destination); // The worklet emits silence, so there is no microphone echo.
      this.timer = setTimeout(() => this.stop(), this.maxSeconds * 1000 + 1000);
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
  stop() {
    this.node?.port.postMessage('stop');
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new Error(t('Не удалось завершить запись. Повторите её или введите текст.'))),
      3000,
    );
  }
  private fail(error: Error) {
    if (!this.finished) {
      this.finished = true;
      this.reject(error);
    }
    this.cleanup();
  }
  cancel() {
    this.cancelled = true;
    this.fail(new Error(t('Запись отменена.')));
  }
  private cleanup() {
    clearTimeout(this.timer);
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.parts = [];
  }
}
