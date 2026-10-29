import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { downloadDir, join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  buildCues,
  formatClock,
  isPunctuation,
  mergeWords,
  slugify,
  speakerLabel,
  toSrt,
  toTxt,
  toVtt,
  type Segment,
} from "./lib/merge";
import type {
  FileInfo,
  JobError,
  ProgressEvent,
  ToolsStatus,
  TranscriptResult,
  UpdateResult,
} from "./lib/types";
import { PlayerBar, usePlayback } from "./player";

type Phase = "idle" | "running" | "who" | "done" | "error";
type ExportKind = "srt" | "vtt" | "txt";

const STEPS_URL = [
  { label: "Download", stages: ["metadata", "download"] },
  { label: "Prepare", stages: ["convert"] },
  { label: "Transcribe", stages: ["model", "transcribe"] },
  { label: "Speakers", stages: ["who"] },
];

const STEPS_FILE = STEPS_URL.slice(1);

const MEDIA_EXTENSIONS = [
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "wmv", "flv",
  "ts", "m2ts", "3gp", "3g2", "ogv", "mp3", "m4a", "m4b", "wav", "flac",
  "ogg", "oga", "opus", "aac", "wma", "aiff", "aif", "amr", "au", "caf",
  "ac3",
];

const MEDIA_FILTER = {
  name: "Video and audio",
  // GTK filters match case, and phone cameras write VIDEO.MP4.
  extensions: MEDIA_EXTENSIONS.flatMap((ext) => [ext, ext.toUpperCase()]),
};

const HOW = [
  {
    label: "Bring audio",
    text: "Paste a YouTube link or choose a local video or audio file.",
  },
  { label: "Prepare", text: "ffmpeg rewrites it as 16 kHz mono." },
  { label: "Transcribe", text: "Voz turns the audio into timed words." },
  { label: "Speakers", text: "Who works out who said what." },
];

function stepIndex(stage: string | null, steps: typeof STEPS_URL): number {
  if (!stage) return -1;
  return steps.findIndex((step) => step.stages.includes(stage));
}

function normalizeUrl(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function fileKind(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "FILE";
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
  const [file, setFile] = useState<{
    path: string;
    name: string;
    size: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [whoProgress, setWhoProgress] = useState<{
    phase: string;
    fraction: number | null;
  } | null>(null);
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<number, string>>({});
  const [whoError, setWhoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
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
  const urlRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const playback = usePlayback(result, segments);

  const renameSpeaker = useCallback((speaker: number, name: string) => {
    setSpeakerNames((current) => ({ ...current, [speaker]: name }));
  }, []);

  const choosePath = useCallback(async (path: string) => {
    try {
      const info = await invoke<FileInfo>("file_info", { path });
      setFile({ path, ...info });
      setPrompt(null);
      setError(null);
      setPhase((current) => (current === "error" ? "idle" : current));
      requestAnimationFrame(() => changeRef.current?.focus());
    } catch (problem) {
      setPrompt(String(problem));
    }
  }, []);

  async function pickFile() {
    if (busyRef.current) return;
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title: "Choose a video or audio file",
        filters: [MEDIA_FILTER],
      });
      if (typeof path === "string") await choosePath(path);
    } catch (problem) {
      setPrompt(String(problem));
    }
  }

  function clearFile() {
    setFile(null);
    setPrompt(null);
    requestAnimationFrame(() => urlRef.current?.focus());
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          if (!busyRef.current) setDragging(true);
          return;
        }
        setDragging(false);
        if (payload.type !== "drop" || busyRef.current) return;
        if (payload.paths.length > 1) {
          setNotice("One file at a time. Using the first.");
        }
        const path = payload.paths[0];
        if (path) choosePath(path);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [choosePath]);

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

    let progressFrame = 0;
    let pendingProgress: ProgressEvent | null = null;
    const publishProgress = (next: ProgressEvent) => {
      pendingProgress = next;
      if (progressFrame) return;
      progressFrame = requestAnimationFrame(() => {
        progressFrame = 0;
        const value = pendingProgress;
        pendingProgress = null;
        if (!value) return;
        setProgress((current) =>
          current?.stage === value.stage && current.percent === value.percent
            ? current
            : value,
        );
      });
    };

    track(
      listen<ProgressEvent>("job:progress", (event) => {
        publishProgress(event.payload);
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
      cancelAnimationFrame(progressFrame);
      unlisten.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const canSeek = playback.canSeek;
  const togglePlayback = playback.toggle;
  useEffect(() => {
    if (!result || !canSeek || settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, button, a, [contenteditable='true']",
        )
      ) {
        return;
      }
      event.preventDefault();
      togglePlayback();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSeek, result, settingsOpen, togglePlayback]);

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
      !(tools.ffmpeg && tools.ffprobe) && "ffmpeg + ffprobe",
      !tools.node && "Node.js",
      !tools.sidecar && "the speech sidecar (run npm run sidecar:install)",
    ].filter(Boolean) as string[];
  }, [tools]);
  const ytDlpMissing = Boolean(tools && !tools.ytDlp);

  const busy = phase === "running" || phase === "who";
  useEffect(() => {
    busyRef.current = busy;
    if (busy) setDragging(false);
  }, [busy]);
  const installedYtDlp = tools?.ytDlpVersion ?? null;
  const upToDate = Boolean(
    installedYtDlp && latestYtDlp && installedYtDlp === latestYtDlp,
  );
  const hasUpdate = Boolean(
    installedYtDlp && latestYtDlp && installedYtDlp !== latestYtDlp,
  );
  const steps = (file ? STEPS_FILE : STEPS_URL).slice(0, speakerLabels ? 4 : 3);
  const currentStep =
    phase === "who"
      ? steps.length - 1
      : phase === "done"
        ? steps.length
        : stepIndex(progress?.stage ?? null, steps);
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
    if (busy) return;
    if (!file && !value) {
      setPrompt("Paste a YouTube link or choose a video or audio file.");
      urlRef.current?.focus();
      return;
    }
    setPrompt(null);
    setError(null);
    setResult(null);
    setSegments([]);
    setSpeakerNames({});
    setSpeakerCount(null);
    setWhoError(null);
    setWhoProgress(null);
    setProgress({
      jobId: "",
      stage: file ? "convert" : "metadata",
      percent: null,
    });
    setPhase("running");
    try {
      await invoke(
        "start_job",
        file ? { path: file.path } : { url: normalizeUrl(value) },
      );
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
    const text = segments.length ? toTxt(segments, speakerNames) : result.text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
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
          ? toSrt(cues, speakerNames)
          : kind === "vtt"
            ? toVtt(cues, speakerNames)
            : toTxt(exportSegments, speakerNames);
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

  const idle = phase === "idle" && !result;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbarInner">
          <div className="wordmark">
            <MarkIcon />
            <span className="name">YT Transcript</span>
          </div>
          <div className="topbarRight">
            <span className="privacyNote">
              <span className="pip" />
              Audio never leaves this machine
            </span>
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
        </div>
      </header>

      <main className="shell main">
        {idle && (
          <section className="intro">
            <h1 className="display">Transcribe a video or audio file.</h1>
            <p className="lede">
              Paste a YouTube link or upload a recording. Word-level timestamps
              and speaker labels, ready to copy or export.
            </p>
          </section>
        )}

        <section className={`composer${idle ? "" : " compact"}`}>
          <form onSubmit={start} className="urlForm">
            <div
              className={`field${file ? " hasFile" : ""}${
                dragging ? " dropping" : ""
              }${busy ? " busy" : ""}`}
            >
              {file ? (
                <>
                  <span className="fieldIcon">
                    <AudioIcon />
                  </span>
                  <span className="fileName" title={file.path}>
                    {file.name}
                  </span>
                  <span className="fileMeta">
                    {fileKind(file.name)} · {formatBytes(file.size)}
                  </span>
                  <button
                    ref={changeRef}
                    type="button"
                    className="fieldChange"
                    onClick={pickFile}
                    disabled={busy}
                    aria-label="Change file"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="fieldClear"
                    onClick={clearFile}
                    disabled={busy}
                    aria-label="Remove file"
                    title="Remove file"
                  >
                    <CloseIcon />
                  </button>
                </>
              ) : (
                <>
                  <span className="fieldIcon">
                    <LinkIcon />
                  </span>
                  <input
                    ref={urlRef}
                    type="text"
                    inputMode="url"
                    value={url}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      if (prompt) setPrompt(null);
                    }}
                    placeholder="Paste a YouTube link"
                    disabled={busy}
                    aria-label="YouTube URL"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  <button
                    type="button"
                    className="fieldUpload"
                    onClick={pickFile}
                    disabled={busy}
                  >
                    <PaperclipIcon />
                    Upload
                  </button>
                </>
              )}
              {dragging && (
                <span className="dropHint">
                  <AudioIcon />
                  {file ? "Drop to replace the file" : "Drop to transcribe"}
                </span>
              )}
            </div>
            {phase === "running" ? (
              <button type="button" className="ghost" onClick={cancel}>
                Cancel
              </button>
            ) : phase === "who" ? (
              <button type="button" className="ghost" disabled>
                Working…
              </button>
            ) : (
              <button type="submit" className="btn">
                Transcribe
              </button>
            )}
          </form>
          {prompt && (
            <p className="prompt" role="status">
              {prompt}
            </p>
          )}
          {!prompt && idle && (
            <p className="hint">
              {file
                ? "Your file stays where it is. English only. The first run downloads a 350 MB speech model, plus a 32 MB speaker model when labelling is on. Temporary audio is deleted on exit."
                : "Paste a link or choose a file. English only. The first run downloads a 350 MB speech model, plus a 32 MB speaker model when labelling is on. Downloaded audio is deleted on exit."}
            </p>
          )}
          {missing.length > 0 && (
            <div className="callout">
              <InfoIcon />
              <span>
                <strong>Missing tools:</strong> {missing.join(", ")}. The app
                looks in its app-data folder and{" "}
                <code>src-tauri/resources/bin</code>, then in your PATH.
              </span>
            </div>
          )}
          {ytDlpMissing && (
            <div className="callout">
              <InfoIcon />
              <span>
                <strong>YouTube links need yt-dlp.</strong> Install it from
                Settings, or choose a video or audio file — file uploads do not
                need it.
              </span>
            </div>
          )}
        </section>

        {(phase === "running" || phase === "who") && (
          <section className="pipeline">
            <div className="stages">
              {steps.map((step, index) => {
                const state =
                  index < currentStep ? "done" : index === currentStep ? "active" : "todo";
                return (
                  <div
                    key={step.label}
                    className={`stage ${state}`}
                    aria-current={state === "active" ? "step" : undefined}
                  >
                    <span className="marker">
                      {state === "done" ? <CheckIcon /> : null}
                    </span>
                    <span>{step.label}</span>
                  </div>
                );
              })}
            </div>
            <div className="now">
              <span aria-live="polite">
                {phase === "who" ? whoLabel : stageLabel(progress?.stage ?? null)}
              </span>
              {showPercent && (
                <span className="pct">{Math.round((shownPercent ?? 0) * 100)}%</span>
              )}
            </div>
            <div className={`rail ${showPercent ? "" : "indeterminate"}`}>
              <span
                style={
                  showPercent
                    ? { transform: `scaleX(${shownPercent ?? 0})` }
                    : undefined
                }
              />
            </div>
          </section>
        )}

        {error && (
          <section className="callout alert" role="alert">
            <AlertIcon />
            <span>
              <strong>Something went wrong</strong>
              <span className="errorText">{error}</span>
              <span className="errorHelp">
                {file
                  ? "Check that the file is a readable video or audio recording and try again."
                  : "Check the link and try again. If yt-dlp is missing, install it from Settings."}
              </span>
            </span>
          </section>
        )}

        {result && (
          <article className="result">
            <div className="resultHead">
              <div>
                <h2>{result.title}</h2>
                <p className="meta">
                  {formatClock(result.duration ?? 0)}
                  {speakerCount !== null && speakerCount > 0 && (
                    <>
                      <span className="sep">·</span>
                      {speakerCount} speakers
                    </>
                  )}
                  <span className="sep">·</span>
                  {result.words.length} words
                </p>
              </div>
              <div className="toolbar">
                <button type="button" onClick={copyTranscript}>
                  Copy
                </button>
                <button type="button" onClick={() => exportAs("srt")}>
                  SRT
                </button>
                <button type="button" onClick={() => exportAs("vtt")}>
                  VTT
                </button>
                <button type="button" onClick={() => exportAs("txt")}>
                  TXT
                </button>
              </div>
            </div>

            {whoError && (
              <div className="callout">
                <AlertIcon />
                <span>
                  <strong>Speaker labels unavailable.</strong> {whoError}
                </span>
              </div>
            )}

            {result.audioUrl && (
              <PlayerBar
                playback={playback}
                peaks={result.waveform ?? []}
                canFollow={segments.length > 0}
              />
            )}

            <Transcript
              segments={segments}
              fallback={result.text}
              speakerNames={speakerNames}
              onRename={renameSpeaker}
              active={playback.active}
              onSeek={playback.canSeek ? playback.playFrom : undefined}
              follow={playback.follow}
              onFollowOff={playback.stopFollowing}
            />
          </article>
        )}

        {idle && (
          <section className="how">
            <ol className="howGrid">
              {HOW.map((step) => (
                <li className="howStep" key={step.label}>
                  <span className="howLabel">{step.label}</span>
                  <span className="howText">{step.text}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {idle && (
          <section className="specimen">
            <p className="specimenCap">Example output</p>
            <div className="specimenRows">
              <div className="specimenRow">
                <span className="time">0:00</span>
                <span className="who sp0">Speaker 1</span>
                <p>Good evening, and welcome to the show.</p>
              </div>
              <div className="specimenRow">
                <span className="time">0:05</span>
                <span className="who sp1">Speaker 2</span>
                <p>Thanks for having me. Where should we start?</p>
              </div>
              <div className="specimenRow">
                <span className="time">0:12</span>
                <span className="who sp0">Speaker 1</span>
                <p>Let us start with the question you came to ask.</p>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="shell footer">
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
                {upToDate && (
                  <span className="chip ok">
                    <span className="pip" />
                    Up to date
                  </span>
                )}
                {hasUpdate && (
                  <span className="chip strong">
                    <span className="pip" />
                    Update available · {latestYtDlp}
                  </span>
                )}
                {!upToDate && !hasUpdate && checkingLatest && (
                  <span className="chip">Checking…</span>
                )}
                {!upToDate && !hasUpdate && !checkingLatest && latestError && (
                  <span className="chip" title={latestError}>
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
            <div className="drawerFoot">
              <p className="fine">Settings apply to the next transcription.</p>
            </div>
          </aside>
        </div>
      )}

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

const Transcript = memo(function Transcript({
  segments,
  fallback,
  speakerNames,
  onRename,
  active,
  onSeek,
  follow,
  onFollowOff,
}: {
  segments: Segment[];
  fallback: string;
  speakerNames: Record<number, string>;
  onRename: (speaker: number, name: string) => void;
  active: { segment: number; word: number };
  onSeek?: (seconds: number) => void;
  follow: boolean;
  onFollowOff: () => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusIndexRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const speakerCounts = useMemo(
    () =>
      segments.reduce<Record<number, number>>((counts, segment) => {
        if (segment.speaker !== null) {
          counts[segment.speaker] = (counts[segment.speaker] ?? 0) + 1;
        }
        return counts;
      }, {}),
    [segments],
  );

  useEffect(() => {
    if (editingIndex !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (returnFocusIndexRef.current !== null) {
      const index = returnFocusIndexRef.current;
      returnFocusIndexRef.current = null;
      document
        .querySelector<HTMLButtonElement>(`[data-segment-index="${index}"]`)
        ?.focus();
    }
  }, [editingIndex]);

  useEffect(() => {
    if (!follow || segments.length === 0 || active.segment < 0) return;
    const element = containerRef.current?.querySelector<HTMLElement>(
      `[data-para-index="${active.segment}"]`,
    );
    element?.scrollIntoView({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [active.segment, follow, reduceMotion, segments.length]);

  useEffect(() => {
    if (!follow || segments.length === 0) return;
    const stop = () => onFollowOff();
    const onKey = (event: KeyboardEvent) => {
      if (!["PageDown", "PageUp", "Home", "End"].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, button, canvas, [contenteditable='true']",
        )
      ) {
        return;
      }
      stop();
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", onKey);
    };
  }, [follow, onFollowOff, segments.length]);

  const beginEdit = useCallback(
    (index: number, label: string) => {
      returnFocusIndexRef.current = index;
      setDraftName(label);
      setEditingIndex(index);
      onFollowOff();
    },
    [onFollowOff],
  );

  function closeEditor() {
    setEditingIndex(null);
  }

  function saveName(event: FormEvent) {
    event.preventDefault();
    const segment = editingIndex === null ? undefined : segments[editingIndex];
    const name = draftName.trim();
    if (segment?.speaker === null || segment === undefined || !name) return;
    onRename(segment.speaker, name);
    closeEditor();
  }

  if (segments.length === 0) {
    return (
      <div className="transcript" ref={containerRef}>
        <p className="plain">{fallback}</p>
      </div>
    );
  }
  const labelled = segments.some((segment) => segment.speaker !== null);
  return (
    <div
      className={`transcript${labelled ? "" : " unlabelled"}${onSeek ? " seekable" : ""}`}
      ref={containerRef}
    >
      {segments.map((segment, index) => {
        const startsTurn =
          index === 0 || segment.speaker !== segments[index - 1].speaker;
        const speaker = segment.speaker;
        const label = speakerLabel(speaker, speakerNames);
        const editing = editingIndex === index && speaker !== null;

        if (editing) {
          return (
            <div
              className={`para ${startsTurn ? "turn-start" : "turn-continue"} speaker-editing${active.segment === index ? " current" : ""}`}
              data-para-index={index}
              key={`${segment.start}-${index}`}
            >
              <TimeCode start={segment.start} onSeek={onSeek} />
              <form
                className="speakerEdit"
                onSubmit={saveName}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeEditor();
                  }
                }}
              >
                <div className="speakerEditRow">
                  <input
                    ref={inputRef}
                    type="text"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    aria-label={`Name for ${label}`}
                    maxLength={48}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="ghost speakerEditSave"
                    disabled={!draftName.trim()}
                  >
                    Save
                  </button>
                  <button type="button" className="ghost" onClick={closeEditor}>
                    Cancel
                  </button>
                </div>
                <p className="speakerEditHint">
                  Changes all {speakerCounts[speaker] ?? 0} transcript{" "}
                  {(speakerCounts[speaker] ?? 0) === 1 ? "passage" : "passages"} and
                  export labels.
                </p>
              </form>
              <div className="speech">
                <p>{segment.text}</p>
              </div>
            </div>
          );
        }

        return (
          <Paragraph
            key={`${segment.start}-${index}`}
            segment={segment}
            index={index}
            startsTurn={startsTurn}
            current={active.segment === index}
            activeWord={active.segment === index ? active.word : -1}
            label={label}
            onSeek={onSeek}
            onBeginEdit={beginEdit}
          />
        );
      })}
    </div>
  );
});

const Paragraph = memo(function Paragraph({
  segment,
  index,
  startsTurn,
  current,
  activeWord,
  label,
  onSeek,
  onBeginEdit,
}: {
  segment: Segment;
  index: number;
  startsTurn: boolean;
  current: boolean;
  activeWord: number;
  label: string;
  onSeek?: (seconds: number) => void;
  onBeginEdit: (index: number, label: string) => void;
}) {
  const speaker = segment.speaker;
  return (
    <div
      className={`para ${startsTurn ? "turn-start" : "turn-continue"}${current ? " current" : ""}`}
      data-para-index={index}
      aria-current={current ? "true" : undefined}
    >
      <TimeCode start={segment.start} onSeek={onSeek} />
      {startsTurn && speaker !== null ? (
        <button
          type="button"
          className={`who ${speakerClass(speaker)} speakerName`}
          onClick={() => onBeginEdit(index, label)}
          data-segment-index={index}
          aria-label={`Rename ${label}`}
          title={`Rename ${label}`}
        >
          <span>{label}</span>
          <PencilIcon />
        </button>
      ) : (
        <span className={`who ${speakerClass(speaker)}`} />
      )}
      <div className="speech">
        <p>
          <span className="words">
            {segment.words.map((word, wordIndex) => (
              <span
                key={`${word.start}-${wordIndex}`}
                className={
                  current && activeWord === wordIndex ? "word active" : "word"
                }
                onClick={
                  onSeek
                    ? (event) => {
                        if (
                          event.shiftKey ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.altKey
                        ) {
                          return;
                        }
                        if (window.getSelection()?.isCollapsed === false) return;
                        onSeek(word.start);
                      }
                    : undefined
                }
              >
                {wordIndex > 0 && !isPunctuation(word.text) ? " " : null}
                {word.text}
              </span>
            ))}
          </span>
        </p>
      </div>
    </div>
  );
});

function TimeCode({
  start,
  onSeek,
}: {
  start: number;
  onSeek?: (seconds: number) => void;
}) {
  const text = formatClock(start);
  if (!onSeek) return <span className="time">{text}</span>;
  return (
    <button
      type="button"
      className="time timeSeek"
      onClick={() => onSeek(start)}
      aria-label={`Play from ${text}`}
    >
      {text}
    </button>
  );
}

function PencilIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m10.9 2.2 2.9 2.9M2.4 13.6l2.8-.6 8-8a1.3 1.3 0 0 0-1.8-1.8l-8 8-.6 2.4Z" />
    </svg>
  );
}

function speakerClass(speaker: number | null): string {
  return speaker === null ? "unknown" : `sp${speaker % 4}`;
}

function MarkIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2.25" />
      <path d="M5.75 6.75h6.5M5.75 9.25h6.5M5.75 11.75h3.5" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.5 13.5a4.5 4.5 0 0 0 6.36 0l2.83-2.83a4.5 4.5 0 0 0-6.36-6.36l-1.3 1.3" />
      <path d="M13.5 10.5a4.5 4.5 0 0 0-6.36 0l-2.83 2.83a4.5 4.5 0 0 0 6.36 6.36l1.3-1.3" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 10.5v3M7 6.5v11M11 9v6M15 4.5v15M19 8.5v7M23 10.5v3" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m20.5 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </svg>
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

function AlertIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4 2.9 20h18.2L12 4Z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.2h.01" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 11.2V16" />
      <path d="M12 7.9h.01" />
    </svg>
  );
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
