import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { exportTranscript } from "./transcript-export";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("exportTranscript", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("sends the default filename and content without a renderer-selected path", async () => {
    vi.mocked(invoke).mockResolvedValue("my-recording.srt");
    const result = await exportTranscript(
      {
        jobId: "job",
        title: "My Recording!",
        duration: null,
        audioPath: "",
        audioUrl: "",
        waveform: [],
        text: "hello",
        words: [{ text: "Hello", start: 0, end: 0.5 }],
        saved: false,
      },
      [],
      {},
      "srt",
    );

    expect(result).toBe("my-recording.srt");
    expect(invoke).toHaveBeenCalledOnce();
    const [command, payload] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe("export_text");
    expect(payload).toMatchObject({ name: "my-recording.srt", extension: "srt" });
    expect(payload).toHaveProperty("contents");
    expect(payload).not.toHaveProperty("path");
  });
});
