import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobResult, ThermalEvent } from "../../lib/wire-types";
import { useTranscriptSession } from "../transcript/use-transcript-session";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
  states: [] as unknown[],
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => undefined | (() => void)) => harness.effects.push(effect),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = harness.states.length;
    harness.states.push(initial);
    return [
      initial,
      (next: unknown) => {
        const current = harness.states[index];
        harness.states[index] =
          typeof next === "function" ? (next as (value: unknown) => unknown)(current) : next;
      },
    ];
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./diarization-client", () => ({
  abortDiarization: vi.fn(),
  diarize: vi.fn(),
  ThermalGuardError: class extends Error {
    constructor() {
      super("Speaker labeling stopped because the CPU reached the thermal pause limit.");
    }
  },
  warm: vi.fn(),
}));

import { diarize } from "./diarization-client";
import { useJobPipeline } from "./use-job-pipeline";

describe("useJobPipeline early errors", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    harness.effects = [];
    harness.states = [];
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(diarize).mockReset();
  });

  it("applies an error emitted before start acceptance and permits another start", async () => {
    const handlers = new Map<
      string,
      (event: { payload: { jobId: string; message: string } }) => void
    >();
    vi.mocked(listen).mockImplementation(((name: string, handler: (event: never) => void) => {
      handlers.set(
        name,
        handler as (event: { payload: { jobId: string; message: string } }) => void,
      );
      return Promise.resolve(vi.fn());
    }) as typeof listen);
    let accept!: (value: { job_id: string }) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "start_job") return new Promise((resolve) => (accept = resolve));
      return Promise.resolve();
    });

    const pipeline = useJobPipeline({ current: false }, vi.fn(), vi.fn());
    harness.effects[0]?.();
    const first = pipeline.start({ path: "/audio.wav" }, "balanced", true);
    handlers.get("job:error")?.({ payload: { jobId: "job-1", message: "sidecar failed" } });
    accept({ job_id: "job-1" });
    await first;

    expect(harness.states[0]).toBe("error");
    expect(harness.states[1]).toBeNull();
    expect(harness.states[8]).toBe("sidecar failed");

    let acceptNext!: (value: { job_id: string }) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => (acceptNext = resolve)));
    const next = pipeline.start({ path: "/next.wav" }, "balanced", true);
    acceptNext({ job_id: "job-2" });
    await next;
    expect(harness.states[0]).toBe("running");
    expect(harness.states[8]).toBeNull();
  });

  it("does not apply an early error belonging to a different accepted job", async () => {
    const handlers = new Map<
      string,
      (event: { payload: { jobId: string; message: string } }) => void
    >();
    vi.mocked(listen).mockImplementation(((name: string, handler: (event: never) => void) => {
      handlers.set(
        name,
        handler as (event: { payload: { jobId: string; message: string } }) => void,
      );
      return Promise.resolve(vi.fn());
    }) as typeof listen);
    let accept!: (value: { job_id: string }) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => (accept = resolve)));

    const pipeline = useJobPipeline({ current: false }, vi.fn(), vi.fn());
    harness.effects[0]?.();
    const start = pipeline.start({ path: "/audio.wav" }, "balanced", true);
    handlers.get("job:error")?.({ payload: { jobId: "old-job", message: "stale" } });
    accept({ job_id: "job-2" });
    await start;

    expect(harness.states[0]).toBe("running");
    expect(harness.states[8]).toBeNull();
  });

  it("does not revive a cancelled pre-start job when start acceptance arrives", async () => {
    const handlers = new Map<
      string,
      (event: { payload: { jobId: string; message: string } }) => void
    >();
    vi.mocked(listen).mockImplementation(((name: string, handler: (event: never) => void) => {
      handlers.set(
        name,
        handler as (event: { payload: { jobId: string; message: string } }) => void,
      );
      return Promise.resolve(vi.fn());
    }) as typeof listen);
    let accept!: (value: { job_id: string }) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "start_job") return new Promise((resolve) => (accept = resolve));
      return Promise.resolve();
    });

    const pipeline = useJobPipeline({ current: false }, vi.fn(), vi.fn());
    harness.effects[0]?.();
    const start = pipeline.start({ path: "/audio.wav" }, "balanced", true);
    const cancel = pipeline.cancel();
    handlers.get("job:error")?.({ payload: { jobId: "job-1", message: "Cancelled" } });
    accept({ job_id: "job-1" });
    await Promise.all([start, cancel]);

    expect(harness.states[0]).toBe("idle");
    expect(harness.states[1]).toBeNull();
    expect(harness.states[8]).toBeNull();
  });

  it("keeps thermal unavailability separate when Who succeeds", async () => {
    const handlers = new Map<string, (event: { payload: JobResult | ThermalEvent }) => void>();
    vi.mocked(listen).mockImplementation(((name: string, handler: (event: never) => void) => {
      handlers.set(name, handler as (event: { payload: JobResult | ThermalEvent }) => void);
      return Promise.resolve(vi.fn());
    }) as typeof listen);
    const unavailable = {
      available: false,
      temperatureC: null,
      pauseAtC: null,
      resumeAtC: null,
      coolDwellSeconds: 0,
      reason: "CPU thermal monitoring is only supported on Linux.",
    };
    let accept!: (started: { job_id: string }) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "start_job") return new Promise((resolve) => (accept = resolve));
      if (command === "thermal_status") return Promise.resolve(unavailable);
      return Promise.resolve();
    });
    vi.stubGlobal("window", {
      setTimeout: vi.fn((callback: () => void, ms: number) => {
        if (ms === 1000) queueMicrotask(callback);
        return 1;
      }),
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }),
    );
    vi.mocked(diarize).mockResolvedValue({
      speakerCount: 1,
      turns: [{ speaker: 0, start: 0, end: 1 }],
    });

    const job = useJobPipeline({ current: true }, vi.fn(), vi.fn());
    harness.effects[0]?.();
    const starting = job.start({ path: "/audio.wav" }, "balanced", true);
    handlers.get("job:thermal")?.({
      payload: { jobId: "job-1", state: "unavailable", status: unavailable },
    });
    accept({ job_id: "job-1" });
    await starting;
    expect(harness.states[9]).toEqual(unavailable);
    expect(harness.states[10]).toBe("unavailable");
    const transcript: JobResult = {
      jobId: "job-1",
      title: "Interview",
      duration: 1,
      audioPath: "/audio.wav",
      audioUrl: "http://127.0.0.1/audio",
      waveform: [],
      text: "hello",
      words: [{ text: "hello", start: 0, end: 1 }],
      saved: true,
      cpuThreads: 2,
      thermalGuardEnabled: true,
    };
    handlers.get("job:result")?.({ payload: transcript });
    await vi.waitFor(() => expect(harness.states[0]).toBe("done"));

    expect(harness.states[7]).toBeNull();
    expect(harness.states[9]).toMatchObject({ available: false, reason: unavailable.reason });
    expect(harness.states[10]).toBe("unavailable");
    expect(harness.states[4]).toMatchObject([{ text: "hello", speaker: 0 }]);
    expect(invoke).toHaveBeenCalledWith(
      "save_analysis",
      expect.objectContaining({ id: "job-1", speakerCount: 1 }),
    );
  });

  it("retries Who with saved transcript word corrections", async () => {
    const handlers = new Map<string, (event: { payload: JobResult }) => void>();
    vi.mocked(listen).mockImplementation(((name: string, handler: (event: never) => void) => {
      handlers.set(name, handler as (event: { payload: JobResult }) => void);
      return Promise.resolve(vi.fn());
    }) as typeof listen);
    const status = (temperatureC: number) => ({
      available: true,
      temperatureC,
      pauseAtC: 90,
      resumeAtC: 80,
      coolDwellSeconds: 0,
      reason: null,
    });
    const readings = [95, 89, 79, 79, 70, 70, 95, 70, 70].map(status);
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "start_job") return Promise.resolve({ job_id: "job-1" });
      if (command === "thermal_status") return Promise.resolve(readings.shift() ?? status(70));
      return Promise.resolve();
    });
    vi.stubGlobal("window", {
      setTimeout: vi.fn((callback: () => void, ms: number) => {
        if (ms === 1000) queueMicrotask(callback);
        return 1;
      }),
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }),
    );
    let finishFirstWho!: (value: {
      speakerCount: number;
      turns: { speaker: number; start: number; end: number }[];
    }) => void;
    vi.mocked(diarize)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstWho = resolve;
          }),
      )
      .mockResolvedValueOnce({
        speakerCount: 1,
        turns: [{ speaker: 0, start: 0, end: 1 }],
      });

    const job = useJobPipeline({ current: true }, vi.fn(), vi.fn());
    harness.effects[0]?.();
    await job.start({ path: "/audio.wav" }, "balanced", true);
    const original: JobResult = {
      jobId: "job-1",
      title: "Interview",
      duration: 1,
      audioPath: "/audio.wav",
      audioUrl: "http://127.0.0.1/audio",
      waveform: [],
      text: "hello",
      words: [{ text: "hello", start: 0, end: 1 }],
      saved: true,
      cpuThreads: 2,
      thermalGuardEnabled: true,
    };
    handlers.get("job:result")?.({ payload: original });
    await vi.waitFor(() => expect(harness.states[0]).toBe("done"));
    expect(harness.states[7]).toContain("thermal pause limit");
    finishFirstWho({ speakerCount: 0, turns: [] });

    const session = useTranscriptSession(
      harness.states[3] as JobResult,
      job.setResult,
      job.setSegments,
      vi.fn(),
      vi.fn(),
    );
    const correctedWords = [{ text: "world", start: 0, end: 1 }];
    await session.saveWordCorrections(original.words, correctedWords, [
      { speaker: null, start: 0, end: 1, text: "world", words: correctedWords },
    ]);
    const correctedTranscript = harness.states[3] as JobResult;
    expect(correctedTranscript.text).toBe("world");
    job.retryWho(correctedTranscript);
    expect(harness.states[0]).toBe("who");
    await vi.waitFor(() => expect(harness.states[0]).toBe("done"));

    expect(harness.states[7]).toBeNull();
    expect(harness.states[3]).toMatchObject({ text: "world", words: correctedWords });
    expect(harness.states[4]).toMatchObject([{ speaker: 0, text: "world", words: correctedWords }]);
    expect(invoke).toHaveBeenCalledWith(
      "save_word_corrections",
      expect.objectContaining({
        id: "job-1",
        expectedWords: original.words,
        words: correctedWords,
      }),
    );
    const savedAnalyses = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "save_analysis");
    expect(savedAnalyses).toHaveLength(2);
    expect(savedAnalyses[1]?.[1]).toMatchObject({
      id: "job-1",
      speakerCount: 1,
      segments: [expect.objectContaining({ text: "world", speaker: 0, words: correctedWords })],
    });
  });
});
