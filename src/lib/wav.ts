/**
 * Parse the 16 kHz mono PCM16 WAV that the Rust pipeline's ffmpeg step writes.
 * Who can take Float32 samples directly, which skips Web Audio's 44.1 kHz
 * decode and its large intermediate buffer. Returns null for any other format.
 */
export function wavPcm16ToFloat32(
  buffer: ArrayBuffer,
  sampleRate = 16_000,
): Float32Array | null {
  const view = new DataView(buffer);
  if (view.byteLength < 44) return null;
  if (view.getUint32(0, true) !== 0x46464952) return null; // "RIFF"
  if (view.getUint32(8, true) !== 0x45564157) return null; // "WAVE"

  let offset = 12;
  let format: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bits: number;
  } | null = null;

  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;

    if (id === 0x20746d66) {
      // "fmt "
      if (size < 16 || dataStart + 16 > view.byteLength) return null;
      format = {
        audioFormat: view.getUint16(dataStart, true),
        channels: view.getUint16(dataStart + 2, true),
        sampleRate: view.getUint32(dataStart + 4, true),
        bits: view.getUint16(dataStart + 14, true),
      };
    } else if (id === 0x61746164) {
      // "data"
      if (!format) return null;
      if (
        format.audioFormat !== 1 ||
        format.channels !== 1 ||
        format.bits !== 16 ||
        format.sampleRate !== sampleRate
      ) {
        return null;
      }

      const available = Math.min(size, view.byteLength - dataStart);
      const count = Math.floor(available / 2);
      const samples = new Float32Array(count);
      if (dataStart % 2 === 0) {
        const pcm = new Int16Array(buffer, dataStart, count);
        for (let i = 0; i < count; i += 1) samples[i] = pcm[i] / 32768;
      } else {
        for (let i = 0; i < count; i += 1) {
          samples[i] = view.getInt16(dataStart + i * 2, true) / 32768;
        }
      }
      return samples;
    }

    offset = dataStart + size + (size & 1);
  }

  return null;
}
