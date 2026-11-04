import type { ProgressEvent } from "../../lib/wire-types";

type Step = { label: string; stages: string[] };
export function JobProgress({
  phase,
  progress,
  whoProgress,
  thermalState,
  steps,
}: {
  phase: string;
  progress: ProgressEvent | null;
  whoProgress: { phase: string; fraction: number | null } | null;
  thermalState: "monitoring" | "cooling" | "unavailable";
  steps: Step[];
}) {
  const index = (stage: string | null) =>
    stage ? steps.findIndex((step) => step.stages.includes(stage)) : -1;
  const current =
    phase === "who"
      ? steps.length - 1
      : phase === "done"
        ? steps.length
        : index(progress?.stage ?? null);
  const label =
    whoProgress?.phase === "diarize"
      ? "Labeling speakers"
      : (whoProgress?.fraction ?? 1) < 1
        ? "Downloading the speaker model (first run)"
        : "Loading the speaker model";
  const percent = progress?.percent ?? null;
  const show =
    phase === "who"
      ? whoProgress?.phase === "model" && whoProgress.fraction !== null
      : percent !== null &&
        ["download", "transcribe", "model", "done"].includes(progress?.stage ?? "");
  const shown = phase === "who" && whoProgress?.phase === "model" ? whoProgress.fraction : percent;
  const stageLabel =
    progress?.stage === "metadata"
      ? "Reading video info"
      : progress?.stage === "download"
        ? "Downloading audio"
        : progress?.stage === "convert"
          ? "Converting to 16 kHz mono"
          : progress?.stage === "model"
            ? "Loading the speech model"
            : progress?.stage === "transcribe"
              ? "Transcribing"
              : progress?.stage === "done"
                ? "Done"
                : "Working";
  if (phase !== "running" && phase !== "who") return null;
  return (
    <section className="mt-6.5 border-t border-rule pt-5.5">
      <div className="flex items-center">
        {steps.map((step, i) => {
          const state = i < current ? "done" : i === current ? "active" : "todo";
          return (
            <div
              key={step.label}
              className={`relative flex items-center gap-2 whitespace-nowrap text-meta not-last:mr-7.5 not-last:after:absolute not-last:after:left-[calc(100%+9px)] not-last:after:h-px not-last:after:w-5.25 not-last:after:bg-rule not-last:after:content-[''] ${state === "done" ? "text-ink-2" : state === "active" ? "font-semibold text-ink" : "text-ink-3"}`}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span
                className={`grid size-3.75 shrink-0 place-items-center rounded-full ${state === "done" ? "border border-ink bg-ink text-paper" : state === "active" ? "border-[1.5px] border-ink text-transparent" : "border border-rule text-transparent"}`}
              >
                {state === "done" ? <CheckIcon /> : null}
              </span>
              <span>{step.label}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-5 flex items-baseline justify-between gap-3.5 text-[16px] font-medium text-ink">
        <span aria-live="polite">
          {thermalState === "cooling"
            ? "Cooling down before processing resumes"
            : phase === "who"
              ? label
              : stageLabel}
        </span>
        {show && (
          <span className="font-mono text-meta font-normal text-ink-3 tabular-nums">
            {Math.round((shown ?? 0) * 100)}%
          </span>
        )}
      </div>
      <div className="mt-3 h-0.75 overflow-hidden rounded-[3px] bg-rule">
        <span
          className={`block h-full origin-left rounded-[3px] bg-ink transition-transform duration-300 ease-expo motion-reduce:transition-none ${show ? "w-full" : "w-[30%] animate-slide motion-reduce:animate-none motion-reduce:transform-none"}`}
          style={show ? { transform: `scaleX(${shown ?? 0})` } : undefined}
        />
      </div>
    </section>
  );
}
function CheckIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m2.5 6.4 2.3 2.3 4.7-5.4" />
    </svg>
  );
}
