import { describe, expect, it, vi } from "vitest";
import { withCpuThreads } from "./diarization-runtime";

describe("withCpuThreads", () => {
  it.each([1, 4, 8])("forwards %i threads without replacing other LiteRT options", (threads) => {
    const loadAndCompile = vi.fn().mockResolvedValue("model");
    const runtime = { loadAndCompile, Tensor: class {} };
    const configured = withCpuThreads(runtime, threads);

    configured.loadAndCompile(new Uint8Array(), { accelerator: "wasm" });

    expect(configured.Tensor).toBe(runtime.Tensor);
    expect(loadAndCompile).toHaveBeenCalledWith(new Uint8Array(), {
      accelerator: "wasm",
      cpuOptions: { numThreads: threads },
    });
  });
});
