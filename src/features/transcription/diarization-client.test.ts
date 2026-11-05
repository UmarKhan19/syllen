import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./diarization-worker.ts?worker&url", () => ({ default: "/worker.js" }));

import { abortDiarization, diarize, ThermalGuardError } from "./diarization-client";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }
}

describe("diarization cancellation", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });
    vi.stubGlobal("Worker", FakeWorker);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:who-worker");
    vi.spyOn(URL, "revokeObjectURL");
  });

  afterEach(() => {
    abortDiarization("test cleanup");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("terminates a loading worker and settles queued requests on thermal abort", async () => {
    const first = diarize(new ArrayBuffer(8), 2);
    const second = diarize(new ArrayBuffer(8), 2);
    const worker = FakeWorker.instances[0];

    abortDiarization(new ThermalGuardError());

    await expect(Promise.all([first, second])).rejects.toBeInstanceOf(ThermalGuardError);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:who-worker");
  });

  it("terminates an active inference worker and settles its request on thermal abort", async () => {
    const pending = diarize(new ArrayBuffer(8), 2);
    const worker = FakeWorker.instances[0];
    worker.onmessage?.({ data: { type: "ready" } } as MessageEvent);
    expect(worker.postMessage).toHaveBeenCalledOnce();

    abortDiarization(new ThermalGuardError());

    await expect(pending).rejects.toBeInstanceOf(ThermalGuardError);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("replaces a completed worker when the thread limit changes", async () => {
    const first = diarize(new ArrayBuffer(8), 2);
    const twoThreadWorker = FakeWorker.instances[0];
    twoThreadWorker.onmessage?.({ data: { type: "ready" } } as MessageEvent);
    const firstRequest = twoThreadWorker.postMessage.mock.calls[0][0] as { id: number };
    twoThreadWorker.onmessage?.({
      data: { type: "result", id: firstRequest.id, speakerCount: 1, turns: [] },
    } as MessageEvent);
    await expect(first).resolves.toEqual({ speakerCount: 1, turns: [] });

    const second = diarize(new ArrayBuffer(8), 4);
    const fourThreadWorker = FakeWorker.instances[1];
    expect(twoThreadWorker.terminate).toHaveBeenCalledOnce();
    fourThreadWorker.onmessage?.({ data: { type: "ready" } } as MessageEvent);
    expect(fourThreadWorker.postMessage).toHaveBeenCalledOnce();
    expect(fourThreadWorker.postMessage.mock.calls[0][0]).toMatchObject({ cpuThreads: 4 });
    const secondRequest = fourThreadWorker.postMessage.mock.calls[0][0] as { id: number };
    fourThreadWorker.onmessage?.({
      data: { type: "result", id: secondRequest.id, speakerCount: 1, turns: [] },
    } as MessageEvent);
    await expect(second).resolves.toEqual({ speakerCount: 1, turns: [] });
  });

  it("rejects old requests but keeps the replacement request queued", async () => {
    const oldRequest = diarize(new ArrayBuffer(8), 2);
    const twoThreadWorker = FakeWorker.instances[0];
    const newRequest = diarize(new ArrayBuffer(8), 4);
    const fourThreadWorker = FakeWorker.instances[1];

    await expect(oldRequest).rejects.toThrow("replaced for a different thread limit");
    fourThreadWorker.onmessage?.({ data: { type: "ready" } } as MessageEvent);
    const request = fourThreadWorker.postMessage.mock.calls[0][0] as { id: number };
    fourThreadWorker.onmessage?.({
      data: { type: "result", id: request.id, speakerCount: 1, turns: [] },
    } as MessageEvent);

    await expect(newRequest).resolves.toEqual({ speakerCount: 1, turns: [] });
    expect(twoThreadWorker.terminate).toHaveBeenCalledOnce();
    expect(fourThreadWorker.postMessage).toHaveBeenCalledOnce();
  });
});
