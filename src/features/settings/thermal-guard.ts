import type { ThermalStatus } from "../../lib/wire-types";

export function readThermalGuard(): boolean {
  try {
    const saved = localStorage.getItem("ytt.thermalGuard");
    return saved !== "false";
  } catch {
    return true;
  }
}

export function persistThermalGuard(enabled: boolean) {
  try {
    localStorage.setItem("ytt.thermalGuard", String(enabled));
  } catch {
    // Settings still apply for this session.
  }
}

export function unavailableThermalStatus(reason: string): ThermalStatus {
  return {
    available: false,
    temperatureC: null,
    pauseAtC: null,
    resumeAtC: null,
    coolDwellSeconds: 0,
    reason,
  };
}

export function validateThermalStatus(value: unknown): ThermalStatus {
  if (!value || typeof value !== "object")
    return unavailableThermalStatus("Invalid thermal status response.");
  const status = value as Partial<ThermalStatus>;
  const finiteOrNull = (number: unknown) =>
    number === null || (typeof number === "number" && Number.isFinite(number));
  if (
    typeof status.available !== "boolean" ||
    !finiteOrNull(status.temperatureC) ||
    !finiteOrNull(status.pauseAtC) ||
    !finiteOrNull(status.resumeAtC) ||
    typeof status.coolDwellSeconds !== "number" ||
    !Number.isSafeInteger(status.coolDwellSeconds) ||
    status.coolDwellSeconds < 0 ||
    !(status.reason === null || typeof status.reason === "string")
  ) {
    return unavailableThermalStatus("Invalid thermal status response.");
  }
  if (
    status.available &&
    (status.temperatureC === null || status.pauseAtC === null || status.resumeAtC === null)
  ) {
    return unavailableThermalStatus("CPU temperature or thermal limits are unavailable.");
  }
  return status as ThermalStatus;
}

export async function waitForThermalCooldown(
  readStatus: () => Promise<ThermalStatus>,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  now: () => number,
): Promise<ThermalStatus> {
  const readOrAbort = () =>
    new Promise<ThermalStatus>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("Cancelled", "AbortError"));
      const onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      readStatus().then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  let status = await readOrAbort();
  if (!status.available) return status;
  if (
    status.temperatureC !== null &&
    status.pauseAtC !== null &&
    status.temperatureC < status.pauseAtC
  )
    return status;

  let coolSince: number | null = null;
  while (!signal.aborted) {
    const cool =
      status.available &&
      status.temperatureC !== null &&
      status.resumeAtC !== null &&
      status.temperatureC <= status.resumeAtC;
    if (!cool) coolSince = null;
    else if (coolSince === null) coolSince = now();
    else if (now() - coolSince >= status.coolDwellSeconds * 1000) return status;

    await sleep(1000, signal);
    status = await readOrAbort();
  }
  throw new DOMException("Cancelled", "AbortError");
}
