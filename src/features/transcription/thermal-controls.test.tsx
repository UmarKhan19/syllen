import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThermalUnavailableNotice } from "../../app";
import { JobProgress } from "./job-progress";
import { SourceForm } from "./source-form";

describe("thermal wait controls", () => {
  it("shows unavailable protection neutrally during Who and for the completed result", () => {
    for (const phase of ["who", "done"]) {
      const html = renderToStaticMarkup(
        createElement(ThermalUnavailableNotice, {
          phase,
          hasResult: true,
          thermalState: "unavailable",
          status: {
            available: false,
            temperatureC: null,
            pauseAtC: null,
            resumeAtC: null,
            coolDwellSeconds: 0,
            reason: "CPU thermal monitoring is only supported on Linux.",
          },
        }),
      );

      expect(html).toContain("Thermal protection unavailable:");
      expect(html).toContain("only supported on Linux");
      expect(html).toContain('role="status"');
      expect(html).toContain("text-ink-2");
      expect(html).not.toContain("text-alert");
      expect(html).not.toContain('role="alert"');
    }
  });

  it("does not carry an unavailable warning to a saved transcript", () => {
    const html = renderToStaticMarkup(
      createElement(ThermalUnavailableNotice, {
        phase: "done",
        hasResult: false,
        thermalState: "unavailable",
        status: null,
      }),
    );
    expect(html).toBe("");
  });

  it("shows truthful cooling copy instead of claiming Who model loading has begun", () => {
    const html = renderToStaticMarkup(
      createElement(JobProgress, {
        phase: "who",
        progress: null,
        whoProgress: null,
        thermalState: "cooling",
        steps: [{ label: "Speakers", stages: ["who"] }],
      }),
    );

    expect(html).toContain("Cooling down before processing resumes");
    expect(html).not.toContain("Loading the speaker model");
  });

  it("keeps native stage progress visible while cooling changes the heading", () => {
    const html = renderToStaticMarkup(
      createElement(JobProgress, {
        phase: "running",
        progress: { jobId: "job", stage: "transcribe", percent: 0.42 },
        whoProgress: null,
        thermalState: "cooling",
        steps: [{ label: "Transcribe", stages: ["transcribe"] }],
      }),
    );

    expect(html).toContain("Cooling down before processing resumes");
    expect(html).toContain("42%");
  });

  it("renders a reachable, enabled speaker-analysis cancel control", () => {
    const html = renderToStaticMarkup(
      createElement(SourceForm, {
        url: "",
        setUrl: vi.fn(),
        file: null,
        prompt: null,
        dragging: false,
        busy: true,
        idle: false,
        wordEditing: false,
        phase: "who",
        onSubmit: vi.fn(),
        onPick: vi.fn(),
        onClear: vi.fn(),
        urlRef: createRef<HTMLInputElement>(),
        changeRef: createRef<HTMLButtonElement>(),
        onCancel: vi.fn(),
        missing: [],
        ytDlpMissing: false,
      }),
    );

    const cancelButton = html.match(/<button\b[^>]*>Cancel speaker analysis<\/button>/)?.[0];
    expect(cancelButton).toBeDefined();
    expect(cancelButton).not.toContain(' disabled=""');
  });
});
