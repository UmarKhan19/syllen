import type { Turn } from "../../lib/transcript";
import type { WhoMessage, WhoPhase } from "./diarization-protocol";
import workerUrl from "./diarization-worker.ts?worker&url";

export interface Diarization {
  speakerCount: number;
  turns: Turn[];
}

interface Pending {
  resolve: (value: Diarization) => void;
  reject: (error: Error) => void;
  onProgress?: (phase: WhoPhase, fraction: number | null) => void;
}

export class ThermalGuardError extends Error {
  constructor() {
    super("Speaker labeling stopped because the CPU reached the thermal pause limit.");
    this.name = "ThermalGuardError";
  }
}

let worker: Worker | null = null;
let workerThreads: number | null = null;
let workerReady = false;
let blobUrl: string | null = null;
let nextId = 1;
const outbox: Array<{ id: number; audio: ArrayBuffer; cpuThreads: number }> = [];
const pending = new Map<number, Pending>();

function rejectAll(message: string | Error) {
  const error = message instanceof Error ? message : new Error(message);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  outbox.length = 0;
}

export function abortDiarization(reason: string | Error) {
  rejectAll(reason);
  resetWorker();
}

function resetWorker() {
  worker?.terminate();
  worker = null;
  workerThreads = null;
  workerReady = false;
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
}

function send(created: Worker, request: { id: number; audio: ArrayBuffer; cpuThreads: number }) {
  const pendingRequest = pending.get(request.id);
  if (!pendingRequest) return;
  try {
    created.postMessage(request, [request.audio]);
  } catch (error) {
    pending.delete(request.id);
    pendingRequest.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function getWorker(cpuThreads: number): Worker {
  if (worker && workerThreads === cpuThreads) return worker;
  if (worker) {
    rejectAll("The speaker worker was replaced for a different thread limit.");
    resetWorker();
  }

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
  workerThreads = cpuThreads;
  return created;
}

/**
 * Start the worker (and its Wasm compile) before the audio fetch resolves.
 * Safe to call more than once.
 */
export function warm(cpuThreads: number) {
  getWorker(cpuThreads);
}

/**
 * Diarize the 16 kHz mono PCM16 WAV bytes in a worker. The buffer is
 * transferred, so the caller must not use it afterwards.
 */
export function diarize(
  audio: ArrayBuffer,
  cpuThreads: number,
  onProgress?: (phase: WhoPhase, fraction: number | null) => void,
): Promise<Diarization> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    let created: Worker;
    try {
      if (!Number.isSafeInteger(cpuThreads) || cpuThreads < 1)
        throw new Error("The CPU thread limit must be a positive integer.");
      created = getWorker(cpuThreads);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!workerReady) {
      // The worker's ESM chunk is still loading; ready replays the outbox.
      outbox.push({ id, audio, cpuThreads });
      return;
    }
    send(created, { id, audio, cpuThreads });
  });
}
