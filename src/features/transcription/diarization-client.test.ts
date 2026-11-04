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
});
