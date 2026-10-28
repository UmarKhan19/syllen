import { describe, expect, it } from "vitest";
import { wavPcm16ToFloat32 } from "./wav";

function wav({
  samples,
  sampleRate = 16_000,
  channels = 1,
  bits = 16,
  audioFormat = 1,
  extraChunk = false,
}: {
  samples: number[];
  sampleRate?: number;
  channels?: number;
  bits?: number;
  audioFormat?: number;
  extraChunk?: boolean;
}): ArrayBuffer {
  const pcmBytes = samples.length * 2;
  const extra = extraChunk ? 8 + 3 + 1 : 0; // "LIST", 3 bytes, one pad byte
  const buffer = new ArrayBuffer(44 + extra + pcmBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");

  let offset = 12;
  if (extraChunk) {
    ascii(offset, "LIST");
    view.setUint32(offset + 4, 3, true);
    ascii(offset + 8, "abc");
    offset += 8 + 3 + 1;
  }

  ascii(offset, "fmt ");
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, audioFormat, true);
  view.setUint16(offset + 10, channels, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, sampleRate * channels * (bits / 8), true);
  view.setUint16(offset + 20, channels * (bits / 8), true);
  view.setUint16(offset + 22, bits, true);
  offset += 24;

  ascii(offset, "data");
  view.setUint32(offset + 4, pcmBytes, true);
  offset += 8;
  for (const sample of samples) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return buffer;
}

describe("wavPcm16ToFloat32", () => {
  it("converts 16 kHz mono PCM16 samples", () => {
    const samples = wavPcm16ToFloat32(wav({ samples: [0, 16384, -32768] }));
    expect(samples).not.toBeNull();
    expect(Array.from(samples!)).toEqual([0, 0.5, -1]);
  });

  it("skips unrelated chunks with odd padding", () => {
    const samples = wavPcm16ToFloat32(
      wav({ samples: [100, -100], extraChunk: true }),
    );
    expect(samples?.length).toBe(2);
    expect(samples![0]).toBeCloseTo(100 / 32768);
  });

  it("rejects formats the pipeline never produces", () => {
    expect(wavPcm16ToFloat32(wav({ samples: [0], channels: 2 }))).toBeNull();
    expect(wavPcm16ToFloat32(wav({ samples: [0], bits: 8 }))).toBeNull();
    expect(wavPcm16ToFloat32(wav({ samples: [0], sampleRate: 44_100 }))).toBeNull();
    expect(wavPcm16ToFloat32(wav({ samples: [0], audioFormat: 3 }))).toBeNull();
  });

  it("rejects non-WAV bytes", () => {
    expect(wavPcm16ToFloat32(new ArrayBuffer(44))).toBeNull();
  });
});
