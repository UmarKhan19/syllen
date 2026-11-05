import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistThermalGuard,
  unavailableThermalStatus,
  readThermalGuard,
  validateThermalStatus,
  waitForThermalCooldown,
} from "./thermal-guard";

const cool = {
  available: true,
  temperatureC: 70,
  pauseAtC: 90,
  resumeAtC: 80,
  coolDwellSeconds: 2,
  reason: null,
};

describe("Thermal Guard setting", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    });
    localStorage.clear();
  });

  it("defaults on, persists, and treats malformed values as the default", () => {
    expect(readThermalGuard()).toBe(true);
    persistThermalGuard(false);
    expect(readThermalGuard()).toBe(false);
    localStorage.setItem("ytt.thermalGuard", "nope");
    expect(readThermalGuard()).toBe(true);
    localStorage.setItem("ytt.thermalGuard", "false");
    expect(readThermalGuard()).toBe(false);
  });

  it("keeps the default and session behavior when browser storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    expect(readThermalGuard()).toBe(true);
    expect(() => persistThermalGuard(false)).not.toThrow();
  });

  it("starts immediately when already below the pause limit", async () => {
    const status = await waitForThermalCooldown(
      vi.fn().mockResolvedValue(cool),
      new AbortController().signal,
      vi.fn(),
      () => 0,
    );
    expect(status).toEqual(cool);
  });

  it("returns unavailable immediately when the initial sensor read fails", async () => {
    const unavailable = unavailableThermalStatus("Sensor unavailable.");
    const sleep = vi.fn();
    const status = await waitForThermalCooldown(
      vi.fn().mockResolvedValue(unavailable),
      new AbortController().signal,
      sleep,
      () => 0,
      true,
    );
    expect(status).toEqual(unavailable);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps waiting after a hot caller observation while between pause and resume", async () => {
    let time = 0;
    const readings = [
      { ...cool, temperatureC: 89 },
      { ...cool, temperatureC: 79 },
      { ...cool, temperatureC: 81 },
      { ...cool, temperatureC: 79 },
      { ...cool, temperatureC: 79 },
      { ...cool, temperatureC: 79 },
    ];
    const sleep = vi.fn(async () => {
      time += 1000;
    });
    const result = await waitForThermalCooldown(
      async () => readings.shift() ?? cool,
      new AbortController().signal,
      sleep,
      () => time,
      true,
    );
    expect(result.temperatureC).toBe(79);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["sensor becomes unavailable", unavailableThermalStatus("Sensor disconnected.")],
    ["temperature reading is lost", { ...cool, temperatureC: null }],
    ["pause threshold is lost", { ...cool, pauseAtC: null }],
    ["resume threshold is lost", { ...cool, resumeAtC: null }],
  ])("returns unavailable when %s during cooldown", async (_scenario, lostStatus) => {
    const controller = new AbortController();
    const readings = [{ ...cool, temperatureC: 89 }, lostStatus];
    const readStatus = vi.fn(async () => readings.shift() ?? lostStatus);
    let sleeps = 0;
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      if (++sleeps === 2) {
        controller.abort();
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      }
    });

    const result = await waitForThermalCooldown(
      readStatus,
      controller.signal,
      sleep,
      () => 0,
      true,
    );

    expect(result).toMatchObject({ available: false });
    expect(result.reason).toBeTruthy();
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("requires continuous dwell at or below resume and resets when warmer", async () => {
    let time = 0;
    const readings = [
      { ...cool, temperatureC: 91 },
      { ...cool, temperatureC: 79 },
      { ...cool, temperatureC: 81 },
      { ...cool, temperatureC: 79 },
      { ...cool, temperatureC: 79 },
      { ...cool, temperatureC: 79 },
    ];
    const readStatus = vi.fn(async () => readings.shift() ?? cool);
    const sleep = vi.fn(async () => {
      time += 1000;
    });
    const result = await waitForThermalCooldown(
      readStatus,
      new AbortController().signal,
      sleep,
      () => time,
    );
    expect(result.temperatureC).toBe(79);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("stops waiting promptly when cancelled", async () => {
    const controller = new AbortController();
    await expect(
      waitForThermalCooldown(
        vi.fn().mockResolvedValue({ ...cool, temperatureC: 95 }),
        controller.signal,
        async (_ms, signal) => {
          controller.abort();
          if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        },
        () => 0,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("treats malformed sensor replies as unavailable rather than protected", () => {
    expect(validateThermalStatus({ ...cool, temperatureC: null })).toMatchObject({
      available: false,
      temperatureC: null,
    });
  });

  it("ignores a sensor reply that arrives after cancellation", async () => {
    const controller = new AbortController();
    let resolveStatus!: (value: typeof cool) => void;
    const pending = new Promise<typeof cool>((resolve) => {
      resolveStatus = resolve;
    });
    const waiting = waitForThermalCooldown(
      () => pending,
      controller.signal,
      vi.fn(),
      () => 0,
    );
    controller.abort();
    resolveStatus({ ...cool, temperatureC: 95 });
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
