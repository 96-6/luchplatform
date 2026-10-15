class LuchPcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunks = new Float32Array(4096);
    this.position = 0;
    this.frames = 0;
    this.limit = Math.floor(sampleRate * Math.min(30, options.processorOptions.maxSeconds));
    this.done = false;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.finish();
    };
  }
  flush() {
    if (!this.position) return;
    const part = this.chunks.slice(0, this.position);
    this.port.postMessage({ samples: part.buffer }, [part.buffer]);
    this.position = 0;
  }
  finish() {
    if (this.done) return;
    this.flush();
    this.done = true;
    this.port.postMessage({ done: true });
  }
  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length && !this.done; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.chunks[this.position++] = sample / channels.length;
      this.frames++;
      if (this.position === this.chunks.length) this.flush();
      if (this.frames >= this.limit) this.finish();
    }
    return !this.done;
  }
}
registerProcessor('luch-pcm-recorder', LuchPcmRecorder);
