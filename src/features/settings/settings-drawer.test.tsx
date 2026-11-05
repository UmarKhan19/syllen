import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsDrawer } from "./settings-drawer";

describe("settings drawer", () => {
  it("keeps unavailable thermal status neutral and disables job settings only while busy", () => {
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
          thermalStatus: {
            available: false,
            temperatureC: null,
            pauseAtC: null,
            resumeAtC: null,
            coolDwellSeconds: 0,
            reason: "CPU thermal monitoring is only supported on Linux.",
          },
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
      const unavailableNotice = html.match(
        /<p\b[^>]*>[^<]*Automatic thermal protection is unavailable;[^<]*<\/p>/,
      )?.[0];

      expect(jobSettings).toHaveLength(4);
      expect(jobSettings.every((input) => input.includes('disabled=""'))).toBe(busy);
      expect(unavailableNotice).toBeDefined();
      expect(unavailableNotice).toContain("CPU thermal monitoring is only supported on Linux.");
      expect(unavailableNotice).toContain('role="status"');
      expect(unavailableNotice).toContain("text-ink-2");
      expect(unavailableNotice).not.toContain("text-alert");
      expect(unavailableNotice).not.toContain('role="alert"');
    }
  });
});
