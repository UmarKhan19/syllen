import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesActiveJobId, retainJobForWhoRetry, startJob } from "./use-job-pipeline";

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
