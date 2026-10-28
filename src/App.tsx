import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { downloadDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import {
  buildCues,
  formatClock,
  mergeWords,
  slugify,
  speakerLabel,
  toSrt,
  toTxt,
  toVtt,
  type Segment,
} from "./lib/merge";
import type {
  JobError,
  ProgressEvent,
  ToolsStatus,
  TranscriptResult,
  UpdateResult,
} from "./lib/types";

type Phase = "idle" | "running" | "who" | "done" | "error";
type ExportKind = "srt" | "vtt" | "txt";

const STEPS = [
  { label: "Download", stages: ["metadata", "download"] },
  { label: "Prepare", stages: ["convert"] },
  { label: "Transcribe", stages: ["model", "transcribe"] },
  { label: "Speakers", stages: ["who"] },
];

function stepIndex(stage: string | null): number {
  if (!stage) return -1;
  return STEPS.findIndex((step) => step.stages.includes(stage));
}

function stageLabel(stage: string | null): string {
  switch (stage) {
    case "metadata":
      return "Reading video info";
    case "download":
      return "Downloading audio";
    case "convert":
      return "Converting to 16 kHz mono";
    case "model":
      return "Loading the speech model";
    case "transcribe":
      return "Transcribing";
    case "done":
      return "Done";
    default:
      return "Working";
  }
}

export default function App() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [whoProgress, setWhoProgress] = useState<{
    phase: string;
    fraction: number | null;
  } | null>(null);
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  const [whoError, setWhoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [speakerLabels, setSpeakerLabels] = useState(() => {
    try {
      return localStorage.getItem("ytt.speakerLabels") !== "false";
    } catch {
      return true;
    }
  });
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateOk, setUpdateOk] = useState(true);
  const [latestYtDlp, setLatestYtDlp] = useState<string | null>(null);
  const [checkingLatest, setCheckingLatest] = useState(false);
  const [latestError, setLatestError] = useState<string | null>(null);

  const speakerLabelsRef = useRef(speakerLabels);
  const gearRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    speakerLabelsRef.current = speakerLabels;
    try {
      localStorage.setItem("ytt.speakerLabels", String(speakerLabels));
    } catch {
      // settings still apply for this session
    }
  }, [speakerLabels]);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const track = (promise: Promise<() => void>) => {
      promise.then((fn) => {
        if (disposed) fn();
        else unlisten.push(fn);
      });
    };

    track(
      listen<ProgressEvent>("job:progress", (event) => {
        setProgress(event.payload);
      }),
    );
    track(
      listen<JobError>("job:error", (event) => {
        const message = event.payload.message;
        if (message === "Cancelled") {
          setPhase("idle");
          setProgress(null);
          return;
        }
        setError(message);
        setPhase("error");
      }),
    );
    track(
      listen<TranscriptResult>("job:result", async (event) => {
        const transcript = event.payload;
        setResult(transcript);
        setSegments([]);
        setSpeakerCount(null);
        setWhoError(null);
        setWhoProgress(null);

        if (!speakerLabelsRef.current) {
          setSegments(mergeWords(transcript.words, []));
          setPhase("done");
          return;
        }

        setPhase("who");
        // Paint the speaker step before the audio fetch starts.
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        try {
          const { diarize, warm } = await import("./lib/who");
          warm();
          const response = await fetch(convertFileSrc(transcript.audioPath));
          if (!response.ok) {
            throw new Error(`The audio file could not be read (${response.status}).`);
          }
          const audio = await response.arrayBuffer();
          const diarization = await diarize(audio, (name, fraction) => {
            setWhoProgress({ phase: name, fraction });
          });
          setSegments(mergeWords(transcript.words, diarization.turns));
          setSpeakerCount(diarization.speakerCount);
        } catch (problem) {
          setSegments(mergeWords(transcript.words, []));
          setWhoError(problem instanceof Error ? problem.message : String(problem));
        } finally {
          setPhase("done");
          setWhoProgress(null);
        }
      }),
    );

    invoke<ToolsStatus>("check_tools")
      .then((status) => {
        if (!disposed) setTools(status);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!settingsOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        gearRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    invoke<ToolsStatus>("check_tools")
      .then(setTools)
      .catch(() => undefined);
    setCheckingLatest(true);
    setLatestError(null);
    invoke<string>("latest_yt_dlp_version")
      .then(setLatestYtDlp)
      .catch((problem) => setLatestError(String(problem)))
      .finally(() => setCheckingLatest(false));
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  const missing = useMemo(() => {
    if (!tools) return [];
    return [
      !tools.ytDlp && "yt-dlp",
      !(tools.ffmpeg && tools.ffprobe) && "ffmpeg + ffprobe",
      !tools.node && "Node.js",
      !tools.sidecar && "the speech sidecar (run npm run sidecar:install)",
    ].filter(Boolean) as string[];
  }, [tools]);

  const busy = phase === "running" || phase === "who";
  const installedYtDlp = tools?.ytDlpVersion ?? null;
  const upToDate = Boolean(
    installedYtDlp && latestYtDlp && installedYtDlp === latestYtDlp,
  );
  const hasUpdate = Boolean(
    installedYtDlp && latestYtDlp && installedYtDlp !== latestYtDlp,
  );
  const steps = speakerLabels ? STEPS : STEPS.slice(0, 3);
  const currentStep =
    phase === "who"
      ? steps.length - 1
      : phase === "done"
        ? steps.length
        : stepIndex(progress?.stage ?? null);
  const whoLabel =
    whoProgress?.phase === "diarize"
      ? "Labeling speakers"
      : (whoProgress?.fraction ?? 1) < 1
        ? "Downloading the speaker model (first run)"
        : "Loading the speaker model";
  const percent = progress?.percent ?? null;
  const showPercent =
    phase === "who"
      ? whoProgress?.phase === "model" && whoProgress.fraction !== null
      : percent !== null &&
        ["download", "transcribe", "model", "done"].includes(progress?.stage ?? "");
  const shownPercent =
    phase === "who" && whoProgress?.phase === "model" ? whoProgress.fraction : percent;

  function toggleSpeakerLabels() {
    const next = !speakerLabels;
    speakerLabelsRef.current = next;
    setSpeakerLabels(next);
  }

  function closeSettings() {
    setSettingsOpen(false);
    gearRef.current?.focus();
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    const value = url.trim();
    if (!value || busy) return;
    setError(null);
    setResult(null);
    setSegments([]);
    setSpeakerCount(null);
    setWhoError(null);
    setWhoProgress(null);
    setProgress({ jobId: "", stage: "metadata", percent: null });
    setPhase("running");
    try {
      await invoke("start_job", { url: value });
    } catch (problem) {
      setError(String(problem));
      setPhase("error");
    }
  }

  async function cancel() {
    try {
      await invoke("cancel_job");
    } catch (problem) {
      setError(String(problem));
      setPhase("error");
    }
  }

  async function copyTranscript() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
    } catch {
      const area = document.createElement("textarea");
      area.value = result.text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setNotice("Transcript copied");
  }

  async function exportAs(kind: ExportKind) {
    if (!result) return;
    try {
      const exportSegments =
        segments.length > 0 ? segments : mergeWords(result.words, []);
      const cues = buildCues(exportSegments);
      const contents =
        kind === "srt"
          ? toSrt(cues)
          : kind === "vtt"
            ? toVtt(cues)
            : toTxt(exportSegments);
      const name = `${slugify(result.title)}.${kind}`;
      let defaultPath = name;
      try {
        defaultPath = await join(await downloadDir(), name);
      } catch {
        // fall back to the dialog's own default location
      }
      const path = await save({
        defaultPath,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (!path) return;
      await invoke("save_text", { path, contents });
      setNotice(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (problem) {
      setError(String(problem));
    }
  }

  async function updateYtDlp() {
    setUpdating(true);
    setUpdateMessage(null);
    try {
      const result = await invoke<UpdateResult>("update_yt_dlp");
      setUpdateOk(result.ok);
      setUpdateMessage(result.message);
      if (result.version) {
        setLatestYtDlp(result.version);
        setLatestError(null);
      }
      setTools(await invoke<ToolsStatus>("check_tools"));
    } catch (problem) {
      setUpdateOk(false);
      setUpdateMessage(String(problem));
    } finally {
      setUpdating(false);
    }
  }

  const transcriptText =
    segments.length > 0
      ? segments.map((segment) => segment.text).join(" ")
      : (result?.text ?? "");

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <p className="eyebrow">Local transcription</p>
          <h1>YT Transcript</h1>
        </div>
        <div className="mastheadRight">
          <p className="tagline">
            Paste a video link. Get a transcript with speaker labels, without
            sending the audio anywhere.
          </p>
          <button
            ref={gearRef}
            type="button"
            className="iconButton"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <section className="composer">
        <form onSubmit={start} className="urlForm">
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            disabled={busy}
            aria-label="Video URL"
            spellCheck={false}
          />
          {phase === "running" ? (
            <button type="button" className="ghost" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button type="submit" disabled={busy || !url.trim()}>
              {phase === "who" ? "Working…" : "Transcribe"}
            </button>
          )}
        </form>
        <p className="hint">
          English only for now. The first run downloads a 350 MB speech model
          (plus a 32 MB speaker model if labeling is on). Audio is deleted when
          the app closes.
        </p>
        {missing.length > 0 && (
          <div className="banner">
            <strong>Missing tools:</strong> {missing.join(", ")}. The app looks
            in its app-data folder and <code>src-tauri/resources/bin</code>, then
            in your PATH. yt-dlp can also be installed from Settings.
          </div>
        )}
      </section>

      {phase !== "idle" && phase !== "error" && (
        <section className="pipeline" aria-live="polite">
          <div className="steps">
            {steps.map((step, index) => {
              const state =
                index < currentStep ? "done" : index === currentStep ? "active" : "todo";
              return (
                <div key={step.label} className={`step ${state}`}>
                  <span className="dot">{index < currentStep ? "✓" : index + 1}</span>
                  <span>{step.label}</span>
                </div>
              );
            })}
          </div>
          <div className="now">
            <span>
              {phase === "who" ? whoLabel : stageLabel(progress?.stage ?? null)}
            </span>
            {showPercent && (
              <span className="pct">{Math.round((shownPercent ?? 0) * 100)}%</span>
            )}
          </div>
          <div className={`bar ${showPercent ? "" : "indeterminate"}`}>
            <span
              style={showPercent ? { width: `${(shownPercent ?? 0) * 100}%` } : undefined}
            />
          </div>
        </section>
      )}

      {error && (
        <section className="error" role="alert">
          <strong>Something went wrong</strong>
          <pre>{error}</pre>
        </section>
      )}

      {result && (
        <article className="result">
          <div className="resultHead">
            <div>
              <h2>{result.title}</h2>
              <p className="meta">
                {formatClock(result.duration ?? 0)}
                {speakerCount !== null && ` · ${speakerCount} speakers`}
                {` · ${result.words.length} words`}
              </p>
            </div>
            <div className="actions">
              <button type="button" className="ghost" onClick={copyTranscript}>
                Copy
              </button>
              <button type="button" className="ghost" onClick={() => exportAs("srt")}>
                SRT
              </button>
              <button type="button" className="ghost" onClick={() => exportAs("vtt")}>
                VTT
              </button>
              <button type="button" className="ghost" onClick={() => exportAs("txt")}>
                TXT
              </button>
            </div>
          </div>

          {whoError && (
            <div className="banner">
              <strong>Speaker labels unavailable.</strong> {whoError}
            </div>
          )}

          <div className="transcript">
            {segments.length === 0 ? (
              <p className="plain">{transcriptText}</p>
            ) : (
              segments.map((segment, index) => (
                <div className="segment" key={`${segment.start}-${index}`}>
                  <div className="side">
                    <span className="time">{formatClock(segment.start)}</span>
                    {segment.speaker !== null && (
                      <span className={`speaker ${speakerClass(segment.speaker)}`}>
                        {speakerLabel(segment.speaker)}
                      </span>
                    )}
                  </div>
                  <p>{segment.text}</p>
                </div>
              ))
            )}
          </div>
        </article>
      )}

      <footer className="footer">
        <span>
          Powered by Desert Ant Labs <strong>Voz</strong> and <strong>Who</strong>.
        </span>
        <span>Models run on this machine.</span>
      </footer>

      {settingsOpen && (
        <div
          className="overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSettings();
          }}
        >
          <aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="drawerHead">
              <h2 id="settings-title">Settings</h2>
              <button
                ref={closeRef}
                type="button"
                className="iconButton"
                onClick={closeSettings}
                aria-label="Close settings"
              >
                <CloseIcon />
              </button>
            </div>

            <section className="setting">
              <div>
                <h3>Speaker labeling</h3>
                <p>
                  Use Who to label who said what. Adds a 32 MB model on first use;
                  it runs in a background worker, so the window stays responsive.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={speakerLabels}
                aria-label="Speaker labeling"
                className={`switch${speakerLabels ? " on" : ""}`}
                onClick={toggleSpeakerLabels}
                disabled={busy}
              >
                <span />
              </button>
            </section>

            <section className="settingBlock">
              <h3>yt-dlp</h3>
              <div className="versionRow">
                <span className="fine">
                  {!tools
                    ? "Checking…"
                    : tools.ytDlp
                      ? `Version ${tools.ytDlpVersion ?? "unknown"}`
                      : "Not installed"}
                </span>
                {upToDate && <span className="badge ok">Up to date</span>}
                {hasUpdate && (
                  <span className="badge outdated">
                    Update available · {latestYtDlp}
                  </span>
                )}
                {!upToDate && !hasUpdate && checkingLatest && (
                  <span className="badge neutral">Checking…</span>
                )}
                {!upToDate && !hasUpdate && !checkingLatest && latestError && (
                  <span className="badge neutral" title={latestError}>
                    Check failed
                  </span>
                )}
              </div>
              <button
                type="button"
                className="ghost"
                onClick={updateYtDlp}
                disabled={busy || updating}
              >
                {updating ? "Updating…" : "Update yt-dlp"}
              </button>
              <p className="fine">
                YouTube changes often. This downloads the latest official yt-dlp
                into the app's data folder and uses that copy; your system install
                is left untouched.
              </p>
              {updateMessage && (
                <pre className={`updateLog ${updateOk ? "ok" : "bad"}`}>
                  {updateMessage}
                </pre>
              )}
            </section>

            {busy && (
              <p className="fine">
                Finish the current transcription to change these settings.
              </p>
            )}
            <p className="fine">Settings apply to the next transcription.</p>
          </aside>
        </div>
      )}

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function speakerClass(speaker: number | null): string {
  return speaker === null ? "unknown" : `sp${speaker % 4}`;
}

function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
