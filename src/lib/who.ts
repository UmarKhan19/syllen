import type { Turn } from "./merge";
import type { WhoMessage, WhoPhase } from "./who-protocol";
import workerUrl from "./who-worker.ts?worker&url";

export interface Diarization {
  speakerCount: number;
  turns: Turn[];
}

interface Pending {
  resolve: (value: Diarization) => void;
  reject: (error: Error) => void;
  onProgress?: (phase: WhoPhase, fraction: number | null) => void;
}

let worker: Worker | null = null;
let workerReady = false;
let blobUrl: string | null = null;
let nextId = 1;
const outbox: Array<{ id: number; audio: ArrayBuffer }> = [];
const pending = new Map<number, Pending>();

function rejectAll(message: string) {
  const error = new Error(message);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  outbox.length = 0;
}

function resetWorker() {
  worker?.terminate();
  worker = null;
  workerReady = false;
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
}

function send(created: Worker, request: { id: number; audio: ArrayBuffer }) {
  const pendingRequest = pending.get(request.id);
  if (!pendingRequest) return;
  try {
    created.postMessage(request, [request.audio]);
  } catch (error) {
    pending.delete(request.id);
    pendingRequest.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function getWorker(): Worker {
  if (worker) return worker;

  const moduleUrl = new URL(workerUrl, window.location.href).href;
  // Who's LiteRT loader uses importScripts, which only classic workers have.
  // A tiny classic stub loads the ESM bundle, keeping Who's top-level await.
  const stub = `import(${JSON.stringify(moduleUrl)}).catch((error) => self.postMessage({ type: "fatal", message: String((error && error.stack) || error) }))`;
  blobUrl = URL.createObjectURL(new Blob([stub], { type: "text/javascript" }));
  const created = new Worker(blobUrl);

  created.onmessage = (event: MessageEvent<WhoMessage>) => {
    const message = event.data;
    if (message.type === "ready") {
      workerReady = true;
      for (const request of outbox.splice(0)) send(created, request);
      return;
    }
    if (message.type === "fatal") {
      rejectAll(message.message);
      resetWorker();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === "progress") {
      request.onProgress?.(message.phase, message.fraction);
    } else if (message.type === "result") {
      pending.delete(message.id);
      request.resolve({
        speakerCount: message.speakerCount,
        turns: message.turns,
      });
    } else {
      pending.delete(message.id);
      request.reject(new Error(message.message));
    }
  };

  created.onerror = (event) => {
    rejectAll(event.message || "The speaker worker failed.");
    resetWorker();
  };

  worker = created;
  return created;
}

/**
 * Start the worker (and its Wasm compile) before the audio fetch resolves.
 * Safe to call more than once.
 */
export function warm() {
  getWorker();
}

/**
 * Diarize the 16 kHz mono PCM16 WAV bytes in a worker. The buffer is
 * transferred, so the caller must not use it afterwards.
 */
export function diarize(
  audio: ArrayBuffer,
  onProgress?: (phase: WhoPhase, fraction: number | null) => void,
): Promise<Diarization> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    let created: Worker;
    try {
      created = getWorker();
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!workerReady) {
      // The worker's ESM chunk is still loading; ready replays the outbox.
      outbox.push({ id, audio });
      return;
    }
    send(created, { id, audio });
  });
}
