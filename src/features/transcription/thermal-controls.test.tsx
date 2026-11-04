import { createRef, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JobProgress } from "./job-progress";
import { SourceForm } from "./source-form";

describe("thermal wait controls", () => {
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
