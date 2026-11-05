import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsDrawer } from "./settings-drawer";

describe("settings drawer job state", () => {
  it("disables every job setting while busy and enables them when idle", () => {
    for (const busy of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(SettingsDrawer, {
          open: true,
          busy,
          speakerLabels: true,
          onToggleSpeakerLabels: vi.fn(),
          resourcePreset: "balanced",
          onResourcePresetChange: vi.fn(),
          thermalGuardEnabled: true,
          onThermalGuardChange: vi.fn(),
          thermalStatus: null,
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
      const jobSettings = html
        .split("<input")
        .slice(1)
        .filter((input) => input.includes('type="radio"') || input.includes('type="checkbox"'));

      expect(jobSettings).toHaveLength(4);
      expect(jobSettings.every((input) => input.includes('disabled=""'))).toBe(busy);
    }
  });
});
