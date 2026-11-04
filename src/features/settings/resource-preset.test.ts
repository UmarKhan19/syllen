import { afterEach, describe, expect, it, vi } from "vitest";
import { persistResourcePreset, RESOURCE_PRESETS, readResourcePreset } from "./resource-preset";

describe("readResourcePreset", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  }

  it("uses balanced by default and for malformed stored values", () => {
    stubStorage();
    expect(readResourcePreset()).toBe("balanced");
    localStorage.setItem("ytt.resourcePreset", "fast");
    expect(readResourcePreset()).toBe("balanced");
  });

  it.each(RESOURCE_PRESETS)("accepts %s", (preset) => {
    stubStorage();
    localStorage.setItem("ytt.resourcePreset", preset);
    expect(readResourcePreset()).toBe(preset);
  });

  it.each(RESOURCE_PRESETS)("persists %s", (preset) => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      setItem: (key: string, value: string) => values.set(key, value),
    });
    persistResourcePreset(preset);
    expect(values.get("ytt.resourcePreset")).toBe(preset);
  });

  it("keeps the selected preset usable when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => persistResourcePreset("battery")).not.toThrow();
  });
});
