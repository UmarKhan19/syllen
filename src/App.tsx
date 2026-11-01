import {
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
  mergeWords,
  slugify,
  toSrt,
  toTxt,
  toVtt,
  type Segment,
} from "./lib/merge";
import { makeSavedWhen } from "./lib/dateLabel";
import type {
  FileInfo,
  JobError,
  LibraryItem,
  ProgressEvent,
  SavedTranscript,
  ToolsStatus,
  TranscriptResult,
  UpdateResult,
} from "./lib/types";
import { PlayerBar, usePlayback } from "./player";
import { Transcript } from "./transcript";

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

// Shared utility strings. SHELL is the page column; ICON_BUTTON, GHOST, CHIP
// and TOOLBAR_BUTTON are the repeated control shapes; FINE is the small print;
// the CALLOUT pair is the note box and its failure variant; the TITLE_HOVER
// pair keeps the old CSS's child-title underline scoped to
// `:hover:not(:disabled)` parents.
const SHELL = "mx-auto w-full max-w-page px-gutter compact:px-7 narrow:px-5";
const ICON_BUTTON =
  "grid size-icon shrink-0 cursor-pointer place-items-center rounded-control border border-rule bg-transparent text-ink-2 transition-colors duration-150 ease-[ease] hover:border-rule-strong hover:bg-sheet hover:text-ink";
const GHOST =
  "cursor-pointer rounded-control border border-rule bg-transparent py-0 text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45";
const CHIP =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-rule bg-sheet px-2.25 py-0.75 text-[11.5px] leading-[1.3]";
const TOOLBAR_BUTTON =
  "h-8.5 cursor-pointer border-0 bg-transparent px-3.5 py-0 text-small text-ink-2 transition-colors duration-150 ease-[ease] hover:bg-wash hover:text-ink";
const FINE = "text-fine leading-[1.6] text-ink-3";
const CALLOUT =
  "mt-4.5 flex gap-2.75 rounded-card border px-4 py-3.25 text-small leading-[1.6] text-ink-2 [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg]:basis-4 [&_strong]:font-semibold";
const CALLOUT_INFO = `${CALLOUT} border-rule bg-sheet [&_svg]:text-ink-3 [&_strong]:text-ink`;
const CALLOUT_ALERT = `${CALLOUT} border-alert-line bg-alert-wash [&_svg]:text-alert [&_strong]:text-alert`;
const RECENT_TITLE_HOVER =
  "enabled:hover:[&>span:nth-child(2)]:underline enabled:hover:[&>span:nth-child(2)]:decoration-1 enabled:hover:[&>span:nth-child(2)]:underline-offset-[3px]";
const LIBRARY_TITLE_HOVER =
  "enabled:hover:[&>span:first-child]:underline enabled:hover:[&>span:first-child]:decoration-1 enabled:hover:[&>span:first-child]:underline-offset-[3px]";

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
  const [library, setLibrary] = useState<LibraryItem[] | null>(null);
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [query, setQuery] = useState("");

  const speakerLabelsRef = useRef(speakerLabels);
  const gearRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const libraryRef = useRef<HTMLButtonElement>(null);
  const libraryCloseRef = useRef<HTMLButtonElement>(null);
  const resultTitleRef = useRef<HTMLHeadingElement>(null);
  const speakerNamesRef = useRef<Record<number, string>>({});
  const busyRef = useRef(false);
  const playback = usePlayback(result, segments);

  const refreshLibrary = useCallback(() => {
    invoke<LibraryItem[]>("list_library")
      .then((items) => {
        setLibrary(items);
        setLibraryError(null);
      })
      .catch((problem) => setLibraryError(String(problem)))
      .finally(() => setLibraryReady(true));
  }, []);

  const renameSpeaker = useCallback(
    (speaker: number, name: string) => {
      const next = { ...speakerNamesRef.current, [speaker]: name };
      speakerNamesRef.current = next;
      setSpeakerNames(next);
      if (!result) return;
      invoke("save_speaker_names", {
        id: result.jobId,
        names: Object.fromEntries(Object.entries(next)),
      }).catch(() => setNotice("The speaker name could not be saved."));
    },
    [result],
  );

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
    refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    if (!libraryOpen) return;
    libraryCloseRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLibraryOpen(false);
      setDeletingId(null);
      libraryRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [libraryOpen]);

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
        setSpeakerNames({});
        speakerNamesRef.current = {};
        setSpeakerCount(null);
        setWhoError(null);
        setWhoProgress(null);
        refreshLibrary();

        const saveSegments = (
          next: Segment[],
          count: number | null,
        ) => {
          invoke("save_analysis", {
            id: transcript.jobId,
            segments: next,
            speakerCount: count,
          })
            .then(refreshLibrary)
            .catch(() => undefined);
        };

        if (!speakerLabelsRef.current) {
          const plain = mergeWords(transcript.words, []);
          setSegments(plain);
          saveSegments(plain, null);
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
          const labelled = mergeWords(transcript.words, diarization.turns);
          setSegments(labelled);
          setSpeakerCount(diarization.speakerCount);
          saveSegments(labelled, diarization.speakerCount);
        } catch (problem) {
          const plain = mergeWords(transcript.words, []);
          setSegments(plain);
          setWhoError(problem instanceof Error ? problem.message : String(problem));
          saveSegments(plain, null);
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

  function openLibrary() {
    if (busy) return;
    setSettingsOpen(false);
    setLibraryOpen(true);
    setQuery("");
    setDeletingId(null);
    setLibraryError(null);
    refreshLibrary();
  }

  function closeLibrary() {
    setLibraryOpen(false);
    setDeletingId(null);
    libraryRef.current?.focus();
  }

  function goHome() {
    if (busy) return;
    if (!result) {
      urlRef.current?.focus();
      return;
    }
    setResult(null);
    setSegments([]);
    setSpeakerNames({});
    speakerNamesRef.current = {};
    setSpeakerCount(null);
    setWhoError(null);
    setWhoProgress(null);
    setError(null);
    setPrompt(null);
    setFile(null);
    setUrl("");
    setPhase("idle");
    setLibraryOpen(false);
    setDeletingId(null);
    window.scrollTo({ top: 0, behavior: "auto" });
    requestAnimationFrame(() => urlRef.current?.focus());
  }

  async function openSaved(item: LibraryItem) {
    if (busy || openingId) return;
    setOpeningId(item.id);
    setLibraryError(null);
    try {
      const saved = await invoke<SavedTranscript>("load_transcript", {
        id: item.id,
      });
      const names = saved.speakerNames ?? {};
      speakerNamesRef.current = names;
      setResult({
        jobId: saved.id,
        title: saved.title,
        duration: saved.duration,
        audioPath: saved.audioPath,
        audioUrl: saved.audioUrl,
        waveform: saved.waveform,
        text: saved.text,
        words: saved.words,
        saved: true,
      });
      setSegments(saved.segments ?? mergeWords(saved.words, []));
      setSpeakerNames(names);
      setSpeakerCount(saved.speakerCount);
      setWhoError(null);
      setWhoProgress(null);
      setError(null);
      setPrompt(null);
      setPhase("done");
      setLibraryOpen(false);
      setDeletingId(null);
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "auto" });
        resultTitleRef.current?.focus();
      });
    } catch (problem) {
      setLibraryError(String(problem));
    } finally {
      setOpeningId(null);
    }
  }

  async function deleteSaved(item: LibraryItem) {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await invoke("delete_transcript", { id: item.id });
      if (result?.jobId === item.id) {
        setResult(null);
        setSegments([]);
        setSpeakerNames({});
        speakerNamesRef.current = {};
        setSpeakerCount(null);
        setPhase("idle");
      }
      setDeletingId(null);
      refreshLibrary();
      setNotice("Transcript and audio deleted");
      requestAnimationFrame(() => libraryCloseRef.current?.focus());
    } catch (problem) {
      setLibraryError(String(problem));
    } finally {
      setDeleteBusy(false);
    }
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
    speakerNamesRef.current = {};
    setSpeakerCount(null);
    setWhoError(null);
    setWhoProgress(null);
    setLibraryOpen(false);
    setDeletingId(null);
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
  // The composer recedes once a transcript is on screen: the field and its
  // controls drop from 54px to 44px and the field inset tightens.
  const composerHeight = idle ? "h-control" : "h-control-sm";
  const composerInset = idle ? "pl-11" : "pl-10.5";
  const hasLibrary = Boolean(library && library.length > 0);
  const recent = library?.slice(0, 3) ?? [];
  // One label source per render: shared today/yesterday snapshot, formatters
  // created only when a row actually asks for a label.
  const savedWhen = makeSavedWhen(new Date());
  const trimmedQuery = query.trim().toLowerCase();
  const filteredLibrary =
    library?.filter((item) =>
      item.title.toLowerCase().includes(trimmedQuery),
    ) ?? [];
  const libraryBytes =
    library?.reduce((total, item) => total + item.audioBytes, 0) ?? 0;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-rule bg-paper">
        <div
          className={`${SHELL} flex h-bar items-center justify-between gap-5`}
        >
          <button
            type="button"
            className="group flex cursor-pointer items-center gap-2.25 border-0 bg-transparent p-0 text-ink"
            onClick={goHome}
            aria-label="Syllen home"
            title="Home"
          >
            <MarkIcon />
            <span className="text-name font-semibold tracking-name group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px]">
              Syllen
            </span>
          </button>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2 text-meta text-ink-3 compact:hidden">
              <span className="size-1.5 shrink-0 rounded-full bg-ok" />
              Audio never leaves this machine
            </span>
            <button
              ref={libraryRef}
              type="button"
              className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.75 whitespace-nowrap rounded-control border border-rule bg-transparent px-2.75 py-0 text-meta font-medium text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:text-ink-3 [&_svg]:transition-colors [&_svg]:duration-150 [&_svg]:ease-[ease] enabled:hover:[&_svg]:text-ink"
              onClick={openLibrary}
              disabled={busy}
              aria-label="Open library"
              title={
                busy
                  ? "Available when this transcription finishes"
                  : "Saved transcripts and audio"
              }
            >
              <LibraryIcon />
              <span>Library</span>
              {library && library.length > 0 && (
                <span className="inline-grid h-4.5 min-w-4.5 place-items-center rounded-full border border-rule-soft bg-wash px-1.25 font-mono text-[10px] text-ink-2 tabular-nums">
                  {library.length}
                </span>
              )}
            </button>
            <button
              ref={gearRef}
              type="button"
              className={ICON_BUTTON}
              onClick={() => {
                setLibraryOpen(false);
                setSettingsOpen(true);
              }}
              aria-label="Settings"
              title="Settings"
            >
              <GearIcon />
            </button>
          </div>
        </div>
      </header>

      <main className={`${SHELL} flex-1 pb-2 compact:py-0`}>
        {idle && (
          <section className="pt-13 narrow:pt-9">
            <h1 className="m-0 text-display font-semibold narrow:text-[28px]">
              Transcribe a video or audio file.
            </h1>
            <p className="mx-0 mt-3 mb-0 max-w-[56ch] text-[15.5px] leading-[1.6] text-ink-2">
              Paste a YouTube link or upload a recording. Word-level timestamps
              and speaker labels, ready to copy or export.
            </p>
          </section>
        )}

        <section className="mt-7">
          <form onSubmit={start} className="flex gap-2.5 narrow:flex-wrap">
            <div
              className={`relative flex min-w-0 flex-1 items-center rounded-card border transition-[border-color,box-shadow,background-color] duration-150 ease-[ease] focus-within:border-ink focus-within:shadow-focus ${
                dragging ? "border-ink" : "border-rule"
              } ${dragging || busy ? "bg-wash" : "bg-sheet"} ${composerHeight} ${
                file ? `pr-1.5 ${composerInset}` : ""
              } narrow:basis-full`}
            >
              {file ? (
                <>
                  <span className="pointer-events-none absolute left-4 flex text-ink-3">
                    <AudioIcon />
                  </span>
                  <span
                    className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-name text-ink"
                    title={file.path}
                  >
                    {file.name}
                  </span>
                  <span className="ml-3 shrink-0 whitespace-nowrap font-mono text-micro tracking-[0.02em] text-ink-3 narrow:hidden">
                    {fileKind(file.name)} · {formatBytes(file.size)}
                  </span>
                  <button
                    ref={changeRef}
                    type="button"
                    className="ml-1.5 h-7.5 shrink-0 cursor-pointer rounded-inline border-0 bg-transparent px-2.25 py-0 text-[12px] text-ink-3 transition-colors duration-150 ease-[ease] enabled:hover:bg-wash enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={pickFile}
                    disabled={busy}
                    aria-label="Change file"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="grid size-7.5 shrink-0 cursor-pointer place-items-center rounded-inline border-0 bg-transparent p-0 text-ink-3 transition-colors duration-150 ease-[ease] enabled:hover:bg-wash enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
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
                  <span className="pointer-events-none absolute left-4 flex text-ink-3">
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
                    className={`h-full min-w-0 flex-1 rounded-card border-0 bg-transparent py-0 pr-3 text-body text-ink placeholder:text-ink-3 focus:outline-none disabled:text-ink-3 ${composerInset}`}
                  />
                  <button
                    type="button"
                    className={`inline-flex h-full shrink-0 cursor-pointer items-center gap-1.75 whitespace-nowrap rounded-r-card border-0 border-l border-rule bg-transparent py-0 font-medium text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:bg-wash enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:text-ink-3 enabled:hover:[&_svg]:text-ink ${
                      idle
                        ? "px-3.75 text-small"
                        : "px-3.25 text-meta"
                    }`}
                    onClick={pickFile}
                    disabled={busy}
                  >
                    <PaperclipIcon />
                    Upload
                  </button>
                </>
              )}
              {dragging && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2.25 rounded-card bg-sheet text-[13.5px] font-medium text-ink [&_svg]:text-ink-3">
                  <AudioIcon />
                  {file ? "Drop to replace the file" : "Drop to transcribe"}
                </span>
              )}
            </div>
            {phase === "running" ? (
              <button
                type="button"
                className={`${GHOST} px-3.5 text-small ${composerHeight}`}
                onClick={cancel}
              >
                Cancel
              </button>
            ) : phase === "who" ? (
              <button
                type="button"
                className={`${GHOST} px-3.5 text-small ${composerHeight}`}
                disabled
              >
                Working…
              </button>
            ) : (
              <button
                type="submit"
                className={`cursor-pointer whitespace-nowrap rounded-card border px-6 py-0 text-[14px] font-semibold tracking-[-0.002em] [transition:background-color_0.15s_ease,box-shadow_0.15s_ease,translate_0.05s_ease] active:enabled:translate-y-px disabled:cursor-not-allowed disabled:border-transparent disabled:bg-disabled disabled:text-disabled-ink narrow:w-full ${composerHeight} ${
                  idle
                    ? "border-ink bg-ink text-on-ink enabled:hover:bg-ink-deep enabled:hover:shadow-button-hover"
                    : "border-rule bg-transparent text-ink enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:shadow-none"
                }`}
              >
                Transcribe
              </button>
            )}
          </form>
          {prompt && (
            <p
              className="mx-0.5 mt-2.5 mb-0 text-meta leading-[1.55] text-ink-2"
              role="status"
            >
              {prompt}
            </p>
          )}
          {!prompt && idle && (
            <p className="mx-0.5 mt-3 mb-0 max-w-[62ch] text-meta leading-[1.55] text-ink-3">
              {file
                ? "Your file stays where it is. English only. The first run downloads a 350 MB speech model, plus a 32 MB speaker model when labelling is on. The transcript and audio are saved in your library on this machine."
                : "Paste a link or choose a file. English only. The first run downloads a 350 MB speech model, plus a 32 MB speaker model when labelling is on. The transcript and audio are saved in your library on this machine."}
            </p>
          )}
          {missing.length > 0 && (
            <div
              className={`${CALLOUT_INFO} [&_code]:rounded-[5px] [&_code]:bg-wash [&_code]:px-1.25 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:whitespace-nowrap [&_code]:text-ink`}
            >
              <InfoIcon />
              <span>
                <strong>Missing tools:</strong> {missing.join(", ")}. The app
                looks in its app-data folder and{" "}
                <code>src-tauri/resources/bin</code>, then in your PATH.
              </span>
            </div>
          )}
          {ytDlpMissing && (
            <div className={CALLOUT_INFO}>
              <InfoIcon />
              <span>
                <strong>YouTube links need yt-dlp.</strong> Install it from
                Settings, or choose a video or audio file — file uploads do not
                need it.
              </span>
            </div>
          )}
        </section>

        {idle && hasLibrary && (
          <section className="mt-10 border-t border-rule" aria-labelledby="recent-title">
            <div className="flex items-baseline justify-between gap-4 pt-4">
              <h2
                id="recent-title"
                className="m-0 text-label font-bold tracking-caps uppercase text-ink"
              >
                Recent transcripts
              </h2>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-fine text-ink-3 underline decoration-dotted decoration-1 underline-offset-[3px] hover:text-ink hover:decoration-solid"
                onClick={openLibrary}
              >
                Open library
              </button>
            </div>
            <ul className="relative mx-0 mt-2 mb-0 list-none p-0 before:absolute before:inset-y-0 before:left-margin before:w-px before:bg-rule before:content-[''] compact:before:hidden">
              {recent.map((item) => (
                <li key={item.id} className="first:*:border-t-0">
                  <button
                    type="button"
                    className={`grid w-full cursor-pointer grid-cols-[154px_minmax(0,1fr)_auto_16px] items-center border-0 border-t border-rule-soft bg-transparent px-0 py-3.25 text-left disabled:cursor-default disabled:opacity-55 compact:grid-cols-[minmax(0,1fr)_auto_16px] compact:gap-y-1 [&_svg]:justify-self-end [&_svg]:text-ink-3 [&_svg]:transition-colors [&_svg]:duration-150 [&_svg]:ease-[ease] enabled:hover:[&_svg]:text-ink ${RECENT_TITLE_HOVER}`}
                    onClick={() => openSaved(item)}
                    disabled={openingId !== null}
                  >
                    <span className="overflow-hidden pr-5 text-right text-ellipsis whitespace-nowrap font-mono text-micro tracking-[0.01em] text-ink-3 tabular-nums compact:col-span-full compact:p-0 compact:text-left">
                      {savedWhen(item.createdAt)}
                    </span>
                    <span className="overflow-hidden pl-5 text-ellipsis whitespace-nowrap text-name font-semibold tracking-name text-ink compact:pl-0">
                      {item.title}
                    </span>
                    <span className="whitespace-nowrap pl-4.5 font-mono text-micro tracking-[0.01em] text-ink-3 tabular-nums compact:pl-3">
                      {formatClock(item.duration ?? 0)}
                      <span className="mx-1.5 text-rule">·</span>
                      {formatBytes(item.audioBytes)}
                    </span>
                    <ChevronIcon />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(phase === "running" || phase === "who") && (
          <section className="mt-6.5 border-t border-rule pt-5.5">
            <div className="flex items-center">
              {steps.map((step, index) => {
                const state =
                  index < currentStep ? "done" : index === currentStep ? "active" : "todo";
                return (
                  <div
                    key={step.label}
                    className={`relative flex items-center gap-2 whitespace-nowrap text-meta not-last:mr-7.5 not-last:after:absolute not-last:after:left-[calc(100%+9px)] not-last:after:h-px not-last:after:w-5.25 not-last:after:bg-rule not-last:after:content-[''] ${
                      state === "done"
                        ? "text-ink-2"
                        : state === "active"
                          ? "font-semibold text-ink"
                          : "text-ink-3"
                    }`}
                    aria-current={state === "active" ? "step" : undefined}
                  >
                    <span
                      className={`grid size-3.75 shrink-0 place-items-center rounded-full ${
                        state === "done"
                          ? "border border-ink bg-ink text-paper"
                          : state === "active"
                            ? "border-[1.5px] border-ink text-transparent"
                            : "border border-rule text-transparent"
                      }`}
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
                {phase === "who" ? whoLabel : stageLabel(progress?.stage ?? null)}
              </span>
              {showPercent && (
                <span className="font-mono text-meta font-normal text-ink-3 tabular-nums">
                  {Math.round((shownPercent ?? 0) * 100)}%
                </span>
              )}
            </div>
            <div className="mt-3 h-0.75 overflow-hidden rounded-[3px] bg-rule">
              <span
                className={`block h-full origin-left rounded-[3px] bg-ink transition-transform duration-300 ease-expo motion-reduce:transition-none ${
                  showPercent
                    ? "w-full"
                    : "w-[30%] animate-slide motion-reduce:animate-none motion-reduce:transform-none"
                }`}
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
          <section
            className={CALLOUT_ALERT}
            role="alert"
          >
            <AlertIcon />
            <span>
              <strong>Something went wrong</strong>
              <span className="mt-2 mb-0 block whitespace-pre-wrap break-words font-mono text-meta leading-[1.6] text-alert">
                {error}
              </span>
              <span className="mt-2.5 block text-meta leading-[1.6] text-ink-2">
                {file
                  ? "Check that the file is a readable video or audio recording and try again."
                  : "Check the link and try again. If yt-dlp is missing, install it from Settings."}
              </span>
            </span>
          </section>
        )}

        {result && (
          <article className="mt-10">
            <div className="flex flex-wrap items-start justify-between gap-6 border-b border-rule pb-5">
              <div>
                <h2
                  ref={resultTitleRef}
                  tabIndex={-1}
                  className="m-0 max-w-[26ch] text-title font-semibold"
                >
                  {result.title}
                </h2>
                <p className="mt-2.25 mb-0 text-meta text-ink-3 tabular-nums">
                  {formatClock(result.duration ?? 0)}
                  {speakerCount !== null && speakerCount > 0 && (
                    <>
                      <span className="mx-2.25 text-rule">·</span>
                      {speakerCount === 1 ? "1 speaker" : `${speakerCount} speakers`}
                    </>
                  )}
                  <span className="mx-2.25 text-rule">·</span>
                  {result.words.length} words
                  <span className="mx-2.25 text-rule">·</span>
                  <span
                    className="inline-flex items-center gap-1.5 whitespace-nowrap"
                    title={
                      result.saved
                        ? "Transcript and audio are stored on this machine"
                        : "This transcript could not be saved to the library"
                    }
                  >
                    <span
                      className={`size-1.25 shrink-0 rounded-full ${
                        result.saved ? "bg-ok" : "bg-ink-3"
                      }`}
                    />
                    {result.saved ? "Saved locally" : "Not saved"}
                  </span>
                </p>
              </div>
              <div className="inline-flex overflow-hidden rounded-control border border-rule bg-sheet">
                <button
                  type="button"
                  className={TOOLBAR_BUTTON}
                  onClick={copyTranscript}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className={`${TOOLBAR_BUTTON} border-l border-rule`}
                  onClick={() => exportAs("srt")}
                >
                  SRT
                </button>
                <button
                  type="button"
                  className={`${TOOLBAR_BUTTON} border-l border-rule`}
                  onClick={() => exportAs("vtt")}
                >
                  VTT
                </button>
                <button
                  type="button"
                  className={`${TOOLBAR_BUTTON} border-l border-rule`}
                  onClick={() => exportAs("txt")}
                >
                  TXT
                </button>
              </div>
            </div>

            {whoError && (
              <div className={CALLOUT_INFO}>
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
          <section className="mt-11.5 border-t border-rule">
            <ol className="m-0 grid list-none grid-cols-4 p-0 compact:grid-cols-2 narrow:grid-cols-1">
              {HOW.map((step) => (
                // <=620: the old nth-child(n+3) rule still wins on the 4th step
                // (20px), and the even steps keep their left divider.
                <li
                  key={step.label}
                  className="pt-4.25 pr-5.5 not-first:border-l not-first:border-rule-soft not-first:pl-5.5 compact:odd:border-l-0 compact:odd:pl-0 compact:nth-[n+3]:pt-5 narrow:odd:border-l-0 narrow:odd:pl-0 narrow:pt-4.5 narrow:nth-3:pt-4.5 narrow:first:pt-4.25"
                >
                  <span className="block text-label font-bold tracking-caps uppercase text-ink">
                    {step.label}
                  </span>
                  <span className="mt-2 block text-meta leading-[1.55] text-ink-3">
                    {step.text}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {idle && libraryReady && !hasLibrary && (
          <section className="relative mt-10.5 border-t border-rule pt-4.5">
            <p className="mt-0 mb-4 text-label tracking-caps uppercase text-ink-3">
              Example output
            </p>
            <div className="relative before:absolute before:inset-y-0 before:left-margin before:w-px before:bg-rule before:content-[''] compact:before:hidden">
              <div className="grid grid-cols-[58px_96px_minmax(0,1fr)] items-start not-first:mt-3.5 compact:block">
                <span className="pt-1.75 pr-5 text-right font-mono text-[11.5px] text-ink-3 tabular-nums compact:inline-block compact:pt-0 compact:pr-3 compact:text-left">
                  0:00
                </span>
                <span className="pt-2 pr-5 text-label font-bold tracking-label uppercase text-pen-1 compact:inline-block compact:pt-0 compact:pr-3 compact:text-left">
                  Speaker 1
                </span>
                <p className="m-0 max-w-[68ch] pl-5 font-text text-prose text-speech text-pretty compact:mt-1.5 compact:pl-0">
                  Good evening, and welcome to the show.
                </p>
              </div>
              <div className="grid grid-cols-[58px_96px_minmax(0,1fr)] items-start not-first:mt-3.5 compact:block">
                <span className="pt-1.75 pr-5 text-right font-mono text-[11.5px] text-ink-3 tabular-nums compact:inline-block compact:pt-0 compact:pr-3 compact:text-left">
                  0:05
                </span>
                <span className="pt-2 pr-5 text-label font-bold tracking-label uppercase text-pen-2 compact:inline-block compact:pt-0 compact:pr-3 compact:text-left">
                  Speaker 2
                </span>
                <p className="m-0 max-w-[68ch] pl-5 font-text text-prose text-speech text-pretty compact:mt-1.5 compact:pl-0">
                  Thanks for having me. Where should we start?
                </p>
              </div>
              <div className="grid grid-cols-[58px_96px_minmax(0,1fr)] items-start not-first:mt-3.5 compact:block">
                <span className="pt-1.75 pr-5 text-right font-mono text-[11.5px] text-ink-3 tabular-nums compact:inline-block compact:pt-0 compact:pr-3 compact:text-left">
                  0:12
                </span>
                <span className="pt-2 pr-5 text-label font-bold tracking-label uppercase text-pen-1 compact:inline-block compact:pt-0 compact:pr-3 compact:text-left">
                  Speaker 1
                </span>
                <p className="m-0 max-w-[68ch] pl-5 font-text text-prose text-speech text-pretty compact:mt-1.5 compact:pl-0">
                  Let us start with the question you came to ask.
                </p>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer
        className="mx-auto mt-13.5 flex w-full max-w-page flex-wrap justify-between gap-4 border-t border-rule px-0 pt-5 pb-7 text-fine text-ink-3 compact:px-7 compact:py-0 narrow:px-5 [&_strong]:font-semibold [&_strong]:text-ink-2"
      >
        <span>
          Powered by Desert Ant Labs <strong>Voz</strong> and <strong>Who</strong>.
        </span>
        <span>Models run on this machine.</span>
      </footer>

      {libraryOpen && (
        <div
          className="fixed inset-0 z-[100] flex animate-fade-in justify-end bg-scrim motion-reduce:animate-none"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeLibrary();
          }}
        >
          <aside
            className="flex h-full w-full max-w-[480px] animate-slide-in flex-col overflow-y-auto border-l border-rule bg-paper px-6.5 pt-6 pb-7.5 shadow-float motion-reduce:animate-none"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-title"
          >
            <div className="flex items-center justify-between gap-4 pb-4.5">
              <div>
                <h2
                  id="library-title"
                  className="m-0 text-[19px] font-semibold tracking-[-0.015em]"
                >
                  Library
                </h2>
                <p className="mt-1.25 mb-0 font-mono text-micro tracking-[0.02em] text-ink-3 tabular-nums">
                  {library === null
                    ? "On this machine"
                    : library.length === 0
                      ? "On this machine"
                      : `${library.length} ${
                          library.length === 1 ? "transcript" : "transcripts"
                        } · ${formatBytes(libraryBytes)}`}
                </p>
              </div>
              <button
                ref={libraryCloseRef}
                type="button"
                className={ICON_BUTTON}
                onClick={closeLibrary}
                aria-label="Close library"
              >
                <CloseIcon />
              </button>
            </div>

            {library && library.length > 5 && (
              <label className="relative mx-0 mt-0.5 mb-4 flex items-center [&_svg]:pointer-events-none [&_svg]:absolute [&_svg]:left-3 [&_svg]:text-ink-3">
                <SearchIcon />
                <input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search transcripts"
                  aria-label="Search transcripts"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9.5 w-full rounded-control border border-rule bg-sheet py-0 pr-3 pl-8.75 text-small placeholder:text-ink-3 focus:border-ink focus:shadow-focus focus:outline-none"
                />
              </label>
            )}

            {libraryError && (
              <div
                className={CALLOUT_ALERT}
                role="alert"
              >
                <AlertIcon />
                <span>
                  <strong>Library unavailable.</strong> {libraryError}
                </span>
              </div>
            )}

            {library === null ? (
              libraryError ? null : (
                <p
                  className="mt-4 mb-0 text-meta leading-[1.6] text-ink-3"
                  role="status"
                >
                  Reading your library…
                </p>
              )
            ) : library.length === 0 ? (
              <div className="border-t border-rule px-4.5 pt-10 pb-8.5 text-center text-ink-3 [&_svg]:size-6.5 [&_strong]:mt-2.5 [&_strong]:block [&_strong]:text-[13.5px] [&_strong]:font-semibold [&_strong]:text-ink [&_p]:mx-auto [&_p]:mt-1.25 [&_p]:mb-0 [&_p]:max-w-[32ch] [&_p]:text-meta [&_p]:leading-[1.6]">
                <LibraryIcon />
                <strong>Nothing saved yet.</strong>
                <p>
                  Finished transcripts and their audio appear here, on this
                  machine.
                </p>
              </div>
            ) : filteredLibrary.length === 0 ? (
              <p className="mt-4 mb-0 text-meta leading-[1.6] text-ink-3">
                No transcript matches “{query.trim()}”.
              </p>
            ) : (
              <ul className="m-0 list-none border-t border-rule p-0">
                {filteredLibrary.map((item) => (
                  <li
                    key={item.id}
                    className={`group flex items-stretch gap-0.5 border-b border-rule-soft last:border-b-0 ${
                      openingId === item.id ? "opacity-55" : ""
                    }`}
                    aria-busy={openingId === item.id || undefined}
                  >
                    {deletingId === item.id ? (
                      <div className="min-w-0 flex-1 pt-3.25 pb-3.5">
                        <p className="mt-0 mb-2.5 text-small leading-[1.5] text-ink-2 wrap-anywhere [&_strong]:font-semibold [&_strong]:text-ink">
                          Delete <strong>{item.title}</strong> and its audio?
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="h-8 cursor-pointer rounded-control border border-alert bg-alert px-3.25 py-0 text-meta font-semibold text-on-ink transition-colors duration-150 ease-[ease] enabled:hover:border-alert-deep enabled:hover:bg-alert-deep disabled:cursor-not-allowed disabled:opacity-55"
                            onClick={() => deleteSaved(item)}
                            disabled={deleteBusy}
                          >
                            {deleteBusy ? "Deleting…" : "Delete"}
                          </button>
                          <button
                            type="button"
                            className={`${GHOST} h-8 px-3 text-meta`}
                            onClick={() => setDeletingId(null)}
                            disabled={deleteBusy}
                            autoFocus
                          >
                            Keep
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`flex min-w-0 flex-1 cursor-pointer flex-col gap-1.25 border-0 bg-transparent py-3.5 pr-2 pl-0 text-left disabled:cursor-default ${LIBRARY_TITLE_HOVER}`}
                          onClick={() => openSaved(item)}
                          disabled={openingId !== null}
                        >
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-name font-semibold leading-[1.35] tracking-name text-ink">
                            {item.title}
                          </span>
                          <span className="flex flex-wrap items-center font-mono text-micro tracking-[0.01em] text-ink-3 tabular-nums">
                            {savedWhen(item.createdAt)}
                            <span className="mx-1.5 text-rule">·</span>
                            {formatClock(item.duration ?? 0)}
                            {item.speakerCount !== null &&
                              item.speakerCount > 0 && (
                                <>
                                  <span className="mx-1.5 text-rule">·</span>
                                  {item.speakerCount === 1
                                    ? "1 speaker"
                                    : `${item.speakerCount} speakers`}
                                </>
                              )}
                            <span className="mx-1.5 text-rule">·</span>
                            {formatBytes(item.audioBytes)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="grid size-8 shrink-0 cursor-pointer place-items-center self-center rounded-inline border-0 bg-transparent p-0 text-ink-3 opacity-45 transition-[opacity,color,background-color] duration-150 ease-[ease] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-alert-wash hover:text-alert"
                          onClick={() => setDeletingId(item.id)}
                          disabled={openingId !== null}
                          aria-label={`Delete ${item.title}`}
                          title="Delete transcript and audio"
                        >
                          <TrashIcon />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-auto border-t border-rule pt-5">
              <p className={FINE}>
                Transcripts and audio are stored in this app's data folder.
                Deleting a transcript deletes its audio too.
              </p>
            </div>
          </aside>
        </div>
      )}

      {settingsOpen && (
        <div
          className="fixed inset-0 z-[100] flex animate-fade-in justify-end bg-scrim motion-reduce:animate-none"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSettings();
          }}
        >
          <aside
            className="flex h-full w-full max-w-[420px] animate-slide-in flex-col overflow-y-auto border-l border-rule bg-paper px-6.5 pt-6 pb-7.5 shadow-float motion-reduce:animate-none"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="flex items-center justify-between gap-4 pb-4.5">
              <h2
                id="settings-title"
                className="m-0 text-[19px] font-semibold tracking-[-0.015em]"
              >
                Settings
              </h2>
              <button
                ref={closeRef}
                type="button"
                className={ICON_BUTTON}
                onClick={closeSettings}
                aria-label="Close settings"
              >
                <CloseIcon />
              </button>
            </div>

            <section className="flex items-start justify-between gap-4.5 border-t border-rule py-5">
              <div>
                <h3 className="mt-0 mb-1.5 text-[14px] font-semibold">
                  Speaker labeling
                </h3>
                <p className="m-0 text-meta leading-[1.6] text-ink-2">
                  Use Who to label who said what. Adds a 32 MB model on first use;
                  it runs in a background worker, so the window stays responsive.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={speakerLabels}
                aria-label="Speaker labeling"
                className={`h-6 w-10.5 shrink-0 cursor-pointer rounded-full border p-0.5 transition-[background-color,border-color] duration-[180ms] ease-[ease] disabled:cursor-not-allowed disabled:opacity-45 ${
                  speakerLabels ? "border-ink bg-ink" : "border-rule bg-sheet"
                }`}
                onClick={toggleSpeakerLabels}
                disabled={busy}
              >
                <span
                  className={`block size-4.5 rounded-full [transition:translate_0.18s_cubic-bezier(0.22,0.61,0.36,1),background-color_0.18s_ease] ${
                    speakerLabels
                      ? "translate-x-4.5 bg-paper"
                      : "bg-ink-3"
                  }`}
                />
              </button>
            </section>

            <section className="flex flex-col items-start gap-3 border-t border-rule py-5">
              <h3 className="mt-0 mb-1.5 text-[14px] font-semibold">yt-dlp</h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className={FINE}>
                  {!tools
                    ? "Checking…"
                    : tools.ytDlp
                      ? `Version ${tools.ytDlpVersion ?? "unknown"}`
                      : "Not installed"}
                </span>
                {upToDate && (
                  <span className={`${CHIP} text-ink-2`}>
                    <span className="size-1.5 shrink-0 rounded-full bg-ok" />
                    Up to date
                  </span>
                )}
                {hasUpdate && (
                  <span className={`${CHIP} text-ink`}>
                    <span className="size-1.5 shrink-0 rounded-full bg-ink-3" />
                    Update available · {latestYtDlp}
                  </span>
                )}
                {!upToDate && !hasUpdate && checkingLatest && (
                  <span className={`${CHIP} text-ink-2`}>Checking…</span>
                )}
                {!upToDate && !hasUpdate && !checkingLatest && latestError && (
                  <span className={`${CHIP} text-ink-2`} title={latestError}>
                    Check failed
                  </span>
                )}

              </div>
              <button
                type="button"
                className={`${GHOST} h-8.5 px-3.5 text-small`}
                onClick={updateYtDlp}
                disabled={busy || updating}
              >
                {updating ? "Updating…" : "Update yt-dlp"}
              </button>
              <p className={`m-0 ${FINE}`}>
                YouTube changes often. This downloads the latest official yt-dlp
                into the app's data folder and uses that copy; your system install
                is left untouched.
              </p>
              {updateMessage && (
                <pre
                  className={`m-0 max-h-47.5 w-full overflow-auto whitespace-pre-wrap break-words rounded-control border bg-sheet px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] ${
                    updateOk
                      ? "border-ok-line text-ok"
                      : "border-alert-line text-alert"
                  }`}
                >
                  {updateMessage}
                </pre>
              )}
            </section>

            {busy && (
              <p className={FINE}>
                Finish the current transcription to change these settings.
              </p>
            )}
            <div className="mt-auto border-t border-rule pt-5">
              <p className={FINE}>
                Settings apply to the next transcription.
              </p>
            </div>
          </aside>
        </div>
      )}

      {notice && (
        <div className="fixed bottom-6.5 left-1/2 z-[120] animate-rise rounded-[10px] border border-rule bg-sheet px-4 py-2.5 text-small text-ink shadow-float [transform:translateX(-50%)] motion-reduce:animate-none">
          {notice}
        </div>
      )}
    </div>
  );
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

function LibraryIcon() {
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
      <path d="M12 6.5c-1.2-1.1-2.8-1.7-4.6-1.7H4v13.4h3.4c1.8 0 3.4.6 4.6 1.8 1.2-1.2 2.8-1.8 4.6-1.8H20V4.8h-3.4c-1.8 0-3.4.6-4.6 1.7Z" />
      <path d="M12 6.5V20" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M9.5 4.5h5M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function ChevronIcon() {
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
      <path d="m9 6 6 6-6 6" />
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
