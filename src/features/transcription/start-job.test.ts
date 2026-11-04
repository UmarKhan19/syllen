import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelJob, matchesActiveJobId, retainJobForWhoRetry, startJob } from "./use-job-pipeline";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("startJob", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it.each([
    [
      { path: "/recording.wav" },
      "battery",
      true,
      { path: "/recording.wav", resourcePreset: "battery", thermalGuardEnabled: true },
    ],
    [
      { url: "https://example.test/video" },
      "performance",
      false,
      {
        url: "https://example.test/video",
        resourcePreset: "performance",
        thermalGuardEnabled: false,
      },
    ],
  ] as const)(
    "sends the selected settings snapshot with the source",
    async (source, preset, thermalGuardEnabled, payload) => {
      await startJob(source, preset, thermalGuardEnabled);
      expect(invoke).toHaveBeenCalledWith("start_job", payload);
    },
  );
});

describe("thermal event job filtering", () => {
  it("rejects old-job and pre-start events once a different job is active", () => {
    expect(matchesActiveJobId("new-job", "old-job")).toBe(false);
    expect(matchesActiveJobId(null, "new-job")).toBe(false);
    expect(matchesActiveJobId("new-job", "new-job")).toBe(true);
  });
});

describe("cancelled Who attempts", () => {
  it("invalidates the old attempt but retains its job ID for a manual retry", () => {
    const job = { id: "job-1", generation: 4, enabled: true, label: true };

    expect(retainJobForWhoRetry(job, 5)).toEqual({ ...job, generation: 5 });
    expect(retainJobForWhoRetry(null, 5)).toBeNull();
  });
});

describe("native job cancellation", () => {
  it("settles running state when native cancellation acknowledges", async () => {
    let phase = "running";
    let progress: string | null = "working";
    await cancelJob(
      async () => {},
      () => true,
      () => {
        phase = "idle";
        progress = null;
      },
      () => {},
    );
    expect({ phase, progress }).toEqual({ phase: "idle", progress: null });
  });

  it("settles on acknowledgement even if the Cancelled event arrived first", async () => {
    let phase = "running";
    let progress: string | null = "working";
    let current = true;
    const settle = () => {
      phase = "idle";
      progress = null;
    };
    let acknowledge!: () => void;
    const pending = cancelJob(
      () => new Promise<void>((resolve) => (acknowledge = resolve)),
      () => current,
      settle,
      () => {},
    );
    settle(); // job:errored can settle before cancel_job acknowledges
    current = false;
    acknowledge();
    await pending;
    expect({ phase, progress }).toEqual({ phase: "idle", progress: null });
  });

  it("waits for this job's start acceptance before sending native cancellation", async () => {
    let accept!: (started: { job_id: string }) => void;
    const calls: string[] = [];
    const pending = cancelJob(
      async () => {
        calls.push("cancel");
      },
      () => true,
      () => calls.push("idle"),
      () => {},
      new Promise<{ job_id: string }>((resolve) => (accept = resolve)),
      (started) => calls.push(`accepted:${started.job_id}`),
    );
    expect(calls).toEqual([]);
    accept({ job_id: "job-1" });
    await pending;
    expect(calls).toEqual(["accepted:job-1", "cancel", "idle"]);
  });

  it("does not cancel another job when the pending start is rejected", async () => {
    let phase = "running";
    const invokeCancel = vi.fn();
    await cancelJob(
      invokeCancel,
      () => true,
      () => {
        phase = "idle";
      },
      () => {},
      Promise.reject(new Error("start rejected")),
    );
    expect(invokeCancel).not.toHaveBeenCalled();
    expect(phase).toBe("idle");
  });

  it("keeps repeated pre-start cancellation queued and only the current one invokes native cancel", async () => {
    let accept!: (started: { job_id: string }) => void;
    let generation = 1;
    const calls: string[] = [];
    const starting = new Promise<{ job_id: string }>((resolve) => (accept = resolve));
    const cancel = (expected: number) =>
      cancelJob(
        async () => {
          calls.push(`cancel:${expected}`);
        },
        () => generation === expected,
        () => calls.push(`idle:${expected}`),
        () => {},
        starting,
      );
    const oldCancel = cancel(1);
    generation = 2;
    const currentCancel = cancel(2);
    accept({ job_id: "job-1" });
    await Promise.all([oldCancel, currentCancel]);
    expect(calls).toEqual(["cancel:2", "idle:2"]);
  });

  it("does not let a stale cancellation acknowledgement clear a newer job", async () => {
    let generation = 1;
    let phase = "running";
    let progress: string | null = "new job";
    let acknowledge!: () => void;
    const pending = cancelJob(
      () => new Promise<void>((resolve) => (acknowledge = resolve)),
      () => generation === 1,
      () => {
        phase = "idle";
        progress = null;
      },
      () => {},
    );
    generation = 2;
    acknowledge();
    await pending;
    expect({ phase, progress }).toEqual({ phase: "running", progress: "new job" });
  });

  it("keeps the job visible and cancellable when native cancellation fails", async () => {
    let phase = "running";
    let error = "";
    await cancelJob(
      async () => {
        throw new Error("IPC failed");
      },
      () => true,
      () => {
        phase = "idle";
      },
      (problem) => {
        error = String(problem);
      },
    );
    expect(phase).toBe("running");
    expect(error).toContain("IPC failed");
  });
});
