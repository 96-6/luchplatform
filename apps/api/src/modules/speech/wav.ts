import { createHash } from 'node:crypto';
import { SPEECH_MAX_WAV_BYTES } from '@luch/contracts';
import { AppError } from '../../errors.js';
export function validateWav(base64: string) {
  const fail = () =>
    new AppError(
      400,
      'INVALID_SPEECH_AUDIO',
      'Нужна запись PCM WAV: моно, 16 кГц, 16 бит, от 0,1 до 30 секунд. Повторите запись или используйте текст.',
    );
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail();
  const audio = Buffer.from(base64, 'base64');
  if (audio.toString('base64') !== base64) throw fail();
  if (
    audio.length < 3244 ||
    audio.length > SPEECH_MAX_WAV_BYTES ||
    audio.length % 2 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.readUInt32LE(4) !== audio.length - 8 ||
    audio.toString('ascii', 8, 12) !== 'WAVE' ||
    audio.toString('ascii', 12, 16) !== 'fmt ' ||
    audio.readUInt32LE(16) !== 16 ||
    audio.readUInt16LE(20) !== 1 ||
    audio.readUInt16LE(22) !== 1 ||
    audio.readUInt32LE(24) !== 16000 ||
    audio.readUInt32LE(28) !== 32000 ||
    audio.readUInt16LE(32) !== 2 ||
    audio.readUInt16LE(34) !== 16 ||
    audio.toString('ascii', 36, 40) !== 'data' ||
    audio.readUInt32LE(40) !== audio.length - 44
  )
    throw fail();
  let energy = 0;
  for (let offset = 44; offset < audio.length; offset += 2)
    energy += Math.abs(audio.readInt16LE(offset));
  if (energy / ((audio.length - 44) / 2) < 1)
    throw new AppError(
      400,
      'SPEECH_SILENCE',
      'В записи не слышно речи. Проверьте микрофон и повторите запись или введите текст.',
    );
  return {
    audio,
    hash: createHash('sha256').update(audio).digest('hex'),
    durationMs: Math.ceil((audio.length - 44) / 32),
  };
}
