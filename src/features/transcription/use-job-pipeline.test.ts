import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    return [initial, (next: unknown) => (harness.states[index] = next)];
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./diarization-client", () => ({
  abortDiarization: vi.fn(),
  diarize: vi.fn(),
  ThermalGuardError: class extends Error {},
  warm: vi.fn(),
}));

import { useJobPipeline } from "./use-job-pipeline";

describe("useJobPipeline early errors", () => {
  beforeEach(() => {
    harness.effects = [];
    harness.states = [];
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
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
});
