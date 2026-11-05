import { Who } from "@desert-ant-labs/who";
import type { WhoMessage, WhoRequest } from "./diarization-protocol";
import { withCpuThreads } from "./diarization-runtime";
import { wavPcm16ToFloat32 } from "./wav";
import { createWhoFetch, createWhoRuntimeFetch, WHO_MODEL_BASE_URL } from "./who-integrity";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WhoRequest>) => void) | null;
  postMessage(message: WhoMessage): void;
};

let loading: Promise<Who> | null = null;

function post(message: WhoMessage) {
  scope.postMessage(message);
}

function load(cpuThreads: number, onProgress: (fraction: number) => void): Promise<Who> {
  loading ??= Promise.race([
    (async () => {
      const originalFetch = self.fetch;
      const guardedFetch = createWhoFetch(originalFetch.bind(self));
      self.fetch = createWhoRuntimeFetch(
        guardedFetch,
        new URL(/* @vite-ignore */ "/litert/", import.meta.url),
      );
      try {
        const runtime = await import("@litertjs/core");
        const who = await Who.load({
          onProgress,
          litertWasmDir: new URL(/* @vite-ignore */ "/litert/", import.meta.url).href,
          modelBaseUrl: WHO_MODEL_BASE_URL,
          litert: withCpuThreads(runtime, cpuThreads),
        });
        return who;
      } finally {
        self.fetch = originalFetch;
      }
    })(),
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
    if (!Number.isSafeInteger(request.cpuThreads) || request.cpuThreads < 1)
      throw new Error("The CPU thread limit must be a positive integer.");
    const who = await load(request.cpuThreads, (fraction) =>
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
