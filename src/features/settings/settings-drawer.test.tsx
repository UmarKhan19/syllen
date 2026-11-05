import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ThermalStatus } from "../../lib/wire-types";
import { SettingsDrawer } from "./settings-drawer";

const unavailableStatus: ThermalStatus = {
  available: false,
  temperatureC: null,
  pauseAtC: null,
  resumeAtC: null,
  coolDwellSeconds: 0,
  reason: "CPU thermal monitoring is only supported on Linux.",
};

function renderSettingsDrawer(thermalStatus: ThermalStatus | null, busy = false) {
  return renderToStaticMarkup(
    createElement(SettingsDrawer, {
      open: true,
      busy,
      speakerLabels: true,
      onToggleSpeakerLabels: vi.fn(),
      resourcePreset: "balanced",
      onResourcePresetChange: vi.fn(),
      thermalGuardEnabled: true,
      onThermalGuardChange: vi.fn(),
      thermalStatus,
      tools: null,
      updating: false,
      updateMessage: null,
      updateOk: false,
      latestYtDlp: null,
      checkingLatest: false,
      latestError: null,
      upToDate: false,
      hasUpdate: false,
      onUpdate: vi.fn(),
      onClose: vi.fn(),
      closeRef: createRef<HTMLButtonElement>(),
    }),
  );
}

function unavailableNotice(html: string) {
  return html.match(/<p\b[^>]*>[^<]*Automatic thermal protection is unavailable;[^<]*<\/p>/)?.[0];
}

describe("settings drawer", () => {
  it("keeps unavailable thermal status neutral and disables job settings only while busy", () => {
    for (const busy of [true, false]) {
      const html = renderSettingsDrawer(unavailableStatus, busy);
      const jobSettings = html
        .split("<input")
        .slice(1)
        .filter((input) => input.includes('type="radio"') || input.includes('type="checkbox"'));
      const notice = unavailableNotice(html);

      expect(jobSettings).toHaveLength(4);
      expect(jobSettings.every((input) => input.includes('disabled=""'))).toBe(busy);
      expect(notice).toBeDefined();
      expect(notice).toContain(unavailableStatus.reason);
      expect(notice).toContain('role="status"');
      expect(notice).toContain("text-ink-2");
      expect(notice).not.toContain("text-alert");
      expect(notice).not.toContain('role="alert"');
    }
  });

  it("shows only a checking state while thermal status is pending", () => {
    const html = renderSettingsDrawer(null);

    expect(html).toContain("Checking CPU temperature and supported limits…");
    expect(html).not.toContain("CPU temperature: Unavailable");
    expect(html).not.toContain("Automatic thermal protection is unavailable");
    expect(html).not.toContain(unavailableStatus.reason);
    expect(unavailableNotice(html)).toBeUndefined();
  });

  it("keeps detected temperature and thresholds visible when available", () => {
    const html = renderSettingsDrawer({
      available: true,
      temperatureC: 68.5,
      pauseAtC: 90,
      resumeAtC: 80,
      coolDwellSeconds: 15,
      reason: null,
    });

    expect(html).toContain("CPU temperature: 68.5 °C");
    expect(html).toContain("Pause at 90 °C · resume at 80 °C after 15s cool.");
    expect(html).not.toContain("Automatic thermal protection is unavailable");
    expect(unavailableNotice(html)).toBeUndefined();
  });
});
