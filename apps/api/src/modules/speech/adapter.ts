import { z } from 'zod';
import type { Reservation } from '../providers/budget.js';
import { boundedBody, type ProviderFetch } from '../providers/adapters.js';
const transcription = z.object({
  text: z.string().trim().min(1).max(1000),
  language_code: z.string().optional(),
});
export class ElevenLabsTranscriptionAdapter {
  constructor(readonly send: ProviderFetch = fetch) {}
  async transcribe(reservation: Reservation, audio: Buffer, language: 'ru' | 'en') {
    const body = new FormData();
    body.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'reply.wav');
    body.set('model_id', reservation.provider.model);
    body.set('language_code', language);
    body.set('diarize', 'false');
    body.set('tag_audio_events', 'false');
    body.set('timestamps_granularity', 'none');
    const response = await this.send('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': reservation.credential },
      body,
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    return transcription.parse(
      JSON.parse((await boundedBody(response, 64 * 1024)).toString('utf8')),
    ).text;
  }
}
