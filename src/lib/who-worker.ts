import { Who } from "@desert-ant-labs/who";
import type { WhoMessage, WhoRequest } from "./who-protocol";
import { wavPcm16ToFloat32 } from "./wav";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WhoRequest>) => void) | null;
  postMessage(message: WhoMessage): void;
};

let loading: Promise<Who> | null = null;

function post(message: WhoMessage) {
  scope.postMessage(message);
}

const LITERT_DIR = "https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/";

function load(onProgress: (fraction: number) => void): Promise<Who> {
  // LiteRT derives its wasm path from the worker's location, which is a blob:
  // URL here. Point it at the CDN instead of the app origin.
  (self as unknown as { Module?: { locateFile?: (path: string) => string } }).Module = {
    locateFile: (path) => new URL(path, LITERT_DIR).href,
  };
  loading ??= Promise.race([
    Who.load({ onProgress }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Speaker model load timed out after 10 minutes.")),
        600_000,
      ),
    ),
  ]).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

scope.onmessage = async (event) => {
  const request = event.data;
  const { id } = request;
  try {
    const samples = wavPcm16ToFloat32(request.audio);
    // Drop the source bytes before the model load and the diarization pass.
    request.audio = new ArrayBuffer(0);
    if (!samples) throw new Error("The audio was not 16 kHz mono PCM.");
    const who = await load((fraction) =>
      post({ type: "progress", id, phase: "model", fraction }),
    );
    post({ type: "progress", id, phase: "diarize", fraction: null });
    const result = await who.diarize({ samples, sampleRate: 16_000 });
    post({
      type: "result",
      id,
      speakerCount: result.speakerCount,
      turns: result.turns.map((turn) => ({
        speaker: turn.speaker,
        start: turn.start,
        end: turn.end,
      })),
    });
  } catch (error) {
    post({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

post({ type: "ready" });
