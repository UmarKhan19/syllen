import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { mergeWords } from "./lib/transcript";
import { toTxt } from "./lib/captions";
import { makeSavedWhen } from "./features/library/date-label";
import { formatBytes } from "./lib/format-bytes";
import type { FileInfo, LibraryItem } from "./lib/wire-types";
import { usePlayback } from "./features/playback/use-playback";
import { useJobPipeline } from "./features/transcription/use-job-pipeline";
import { useLibrary } from "./features/library/use-library";
import { useSettings } from "./features/settings/use-settings";
import { SourceForm } from "./features/transcription/source-form";
import { JobProgress } from "./features/transcription/job-progress";
import { LibraryDrawer } from "./features/library/library-drawer";
import { SettingsDrawer } from "./features/settings/settings-drawer";
import { TranscriptWorkspace } from "./features/transcript/transcript-workspace";
import { exportTranscript, type ExportKind } from "./features/transcript/transcript-export";
import { AlertIcon, LibraryIcon } from "./icons";
import { useUnsavedWordGuard } from "./features/transcript/use-unsaved-word-guard";
import { useTranscriptSession } from "./features/transcript/use-transcript-session";

type FileSource = { path: string; name: string; size: number };
const STEPS_URL = [{ label: "Download", stages: ["metadata", "download"] }, { label: "Prepare", stages: ["convert"] }, { label: "Transcribe", stages: ["model", "transcribe"] }, { label: "Speakers", stages: ["who"] }];
const STEPS_FILE = STEPS_URL.slice(1);
const MEDIA_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "wmv", "flv", "ts", "m2ts", "3gp", "3g2", "ogv", "mp3", "m4a", "m4b", "wav", "flac", "ogg", "oga", "opus", "aac", "wma", "aiff", "aif", "amr", "au", "caf", "ac3"];
const MEDIA_FILTER = { name: "Video and audio", extensions: MEDIA_EXTENSIONS.flatMap((ext) => [ext, ext.toUpperCase()]) };
const HOW = [{ label: "Bring audio", text: "Paste a YouTube link or choose a local video or audio file." }, { label: "Prepare", text: "ffmpeg rewrites it as 16 kHz mono." }, { label: "Transcribe", text: "Voz turns the audio into timed words." }, { label: "Speakers", text: "Who works out who said what." }];
const SHELL = "mx-auto w-full max-w-page px-gutter compact:px-7 narrow:px-5";
const ICON_BUTTON = "grid size-icon shrink-0 cursor-pointer place-items-center rounded-control border border-rule bg-transparent text-ink-2 transition-colors duration-150 ease-[ease] hover:border-rule-strong hover:bg-sheet hover:text-ink";
const ALERT = "mt-4.5 flex gap-2.75 rounded-card border border-alert-line bg-alert-wash px-4 py-3.25 text-small leading-[1.6] text-ink-2 [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg]:basis-4 [&_strong]:font-semibold [&_svg]:text-alert [&_strong]:text-alert";

function normalizeUrl(value: string) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`; }
export default function App() {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<FileSource | null>(null);
  const [dragging, setDragging] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [wordEditing, setWordEditing] = useState(false);
  const library = useLibrary();
  const settings = useSettings(settingsOpen);
  const job = useJobPipeline(settings.speakerLabelsRef, library.refresh, setNotice);
  const transcriptSession = useTranscriptSession(job.result, job.setResult, job.setSegments, library.refresh, setNotice);
  const playback = usePlayback(job.result, job.segments);
  const urlRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const libraryRef = useRef<HTMLButtonElement>(null);
  const libraryCloseRef = useRef<HTMLButtonElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const resultTitleRef = useRef<HTMLHeadingElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarCancelRef = useRef<HTMLButtonElement>(null);
  const toolbarSaveRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const wordEditingRef = useRef(false);
  const wordSavingRef = useRef(false);
  const wordDirtyRef = useRef(false);
  const busy = job.phase === "running" || job.phase === "who";
  const idle = job.phase === "idle" && !job.result;
  const canEditWords = Boolean(job.result?.saved && job.analysisReady && job.phase === "done" && job.segments.length > 0);

  useEffect(() => {
    busyRef.current = busy;
    if (busy) setDragging(false);
  }, [busy]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useUnsavedWordGuard(wordEditingRef, wordSavingRef, wordDirtyRef);

  const choosePath = useCallback(async (path: string) => {
    if (wordEditing) return;
    try {
      const info = await invoke<FileInfo>("file_info", { path });
      setFile({ path, ...info }); setPrompt(null); job.setError(null);
      job.setPhase((current) => current === "error" ? "idle" : current);
      requestAnimationFrame(() => changeRef.current?.focus());
    } catch (problem) { setPrompt(String(problem)); }
  }, [wordEditing]);

  async function pickFile() {
    if (busyRef.current || wordEditing) return;
    try { const path = await open({ multiple: false, directory: false, title: "Choose a video or audio file", filters: [MEDIA_FILTER] }); if (typeof path === "string") await choosePath(path); }
    catch (problem) { setPrompt(String(problem)); }
  }
  function clearFile() { setFile(null); setPrompt(null); requestAnimationFrame(() => urlRef.current?.focus()); }

  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") { if (!busyRef.current && !wordEditing) setDragging(true); return; }
      setDragging(false);
      if (payload.type !== "drop" || busyRef.current || wordEditing) return;
      if (payload.paths.length > 1) setNotice("One file at a time. Using the first.");
      const path = payload.paths[0]; if (path) choosePath(path);
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [choosePath, wordEditing]);

  useEffect(() => {
    if (!job.result || !playback.canSeek || settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
      event.preventDefault(); playback.toggle();
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [job.result, playback.canSeek, playback.toggle, settingsOpen]);

  function openLibrary() {
    if (busy || wordEditing) return;
    setSettingsOpen(false); setLibraryOpen(true); library.setDeletingId(null); library.setError(null); library.refresh();
  }
  const closeLibrary = useCallback(() => { if (wordEditing) return; setLibraryOpen(false); library.setDeletingId(null); libraryRef.current?.focus(); }, [wordEditing, library.setDeletingId]);
  const closeSettings = useCallback(() => { setSettingsOpen(false); gearRef.current?.focus(); }, []);
  function goHome() {
    if (busy || wordEditing) return;
    if (!job.result) { urlRef.current?.focus(); return; }
    job.clearSession(); transcriptSession.clearNames(); setPrompt(null); setFile(null); setUrl(""); setLibraryOpen(false); library.setDeletingId(null);
    window.scrollTo({ top: 0, behavior: "auto" }); requestAnimationFrame(() => urlRef.current?.focus());
  }
  async function openSaved(item: LibraryItem) {
    if (busy || library.openingId || wordEditing) return;
    try {
      const saved = await library.load(item);
      const names = Object.fromEntries(Object.entries(saved.speakerNames ?? {}).map(([key, name]) => [Number(key), name]));
      transcriptSession.restoreNames(names);
      job.showSaved({ jobId: saved.id, title: saved.title, duration: saved.duration, audioPath: saved.audioPath, audioUrl: saved.audioUrl, waveform: saved.waveform, text: saved.text, words: saved.words, saved: true }, saved.segments ?? mergeWords(saved.words, []), saved.speakerCount);
      setPrompt(null); setLibraryOpen(false); library.setDeletingId(null);
      requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: "auto" }); resultTitleRef.current?.focus(); });
    } catch { /* the hook owns and reports the load error */ }
  }
  async function deleteSaved(item: LibraryItem) {
    if (wordEditing) return;
    if (!await library.remove(item)) return;
    if (job.result?.jobId === item.id) { job.clearDeletedSession(); transcriptSession.clearNames(); }
    setNotice("Transcript and audio deleted"); requestAnimationFrame(() => libraryCloseRef.current?.focus());
  }
  async function start(event: FormEvent) {
    event.preventDefault(); const value = url.trim();
    if (busy || wordEditing) return;
    if (!file && !value) { setPrompt("Paste a YouTube link or choose a video or audio file."); urlRef.current?.focus(); return; }
    setPrompt(null); transcriptSession.clearNames(); setLibraryOpen(false); library.setDeletingId(null);
    await job.start(file ? { path: file.path } : { url: normalizeUrl(value) });
  }
  async function copyTranscript() {
    if (!job.result || wordEditing) return;
    const text = job.segments.length ? toTxt(job.segments, transcriptSession.speakerNames) : job.result.text;
    try { await navigator.clipboard.writeText(text); }
    catch { const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }
    setNotice("Transcript copied");
  }
  async function exportAs(kind: ExportKind) {
    if (!job.result || wordEditing) return;
    try { const name = await exportTranscript(job.result, job.segments, transcriptSession.speakerNames, kind); if (name) setNotice(`Saved ${name}`); }
    catch (problem) { job.setError(String(problem)); }
  }

  const steps = (file ? STEPS_FILE : STEPS_URL).slice(0, settings.speakerLabels ? 4 : 3);
  const recent = library.items?.slice(0, 3) ?? [];
  const savedWhen = makeSavedWhen(new Date());
  const hasLibrary = Boolean(library.items?.length);

  return <div className="flex min-h-screen flex-col"><header className="sticky top-0 z-20 border-b border-rule bg-paper" data-app-topbar><div className={`${SHELL} flex h-bar items-center justify-between gap-5`}><button type="button" className="group flex cursor-pointer items-center gap-2.25 border-0 bg-transparent p-0 text-ink" onClick={goHome} disabled={wordEditing} aria-label="Syllen home" title="Home"><MarkIcon /><span className="text-name font-semibold tracking-name group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px]">Syllen</span></button><div className="flex items-center gap-4"><span className="flex items-center gap-2 text-meta text-ink-3 compact:hidden"><span className="size-1.5 shrink-0 rounded-full bg-ok" />Audio never leaves this machine</span><button ref={libraryRef} type="button" className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.75 whitespace-nowrap rounded-control border border-rule bg-transparent px-2.75 py-0 text-meta font-medium text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:text-ink-3 [&_svg]:transition-colors [&_svg]:duration-150 [&_svg]:ease-[ease] enabled:hover:[&_svg]:text-ink" onClick={openLibrary} disabled={busy || wordEditing} aria-label="Open library" title={busy ? "Available when this transcription finishes" : wordEditing ? "Save or cancel word corrections first" : "Saved transcripts and audio"}><LibraryIcon /><span>Library</span>{library.items && library.items.length > 0 && <span className="inline-grid h-4.5 min-w-4.5 place-items-center rounded-full border border-rule-soft bg-wash px-1.25 font-mono text-[10px] text-ink-2 tabular-nums">{library.items.length}</span>}</button><button ref={gearRef} type="button" className={ICON_BUTTON} onClick={() => { setLibraryOpen(false); setSettingsOpen(true); }} aria-label="Settings" title="Settings"><GearIcon /></button></div></div></header>
    <main className={`${SHELL} flex-1 pb-2 compact:py-0`}>{idle && <section className="pt-13 narrow:pt-9"><h1 className="m-0 text-display font-semibold narrow:text-[28px]">Transcribe a video or audio file.</h1><p className="mx-0 mt-3 mb-0 max-w-[56ch] text-[15.5px] leading-[1.6] text-ink-2">Paste a YouTube link or upload a recording. Word-level timestamps and speaker labels, ready to copy or export.</p></section>}
      <SourceForm url={url} setUrl={(next) => { setUrl(next); if (prompt) setPrompt(null); }} file={file} prompt={prompt} dragging={dragging} busy={busy} idle={idle} wordEditing={wordEditing} phase={job.phase} onSubmit={start} onPick={pickFile} onClear={clearFile} urlRef={urlRef} changeRef={changeRef} onCancel={job.cancel} missing={settings.missing} ytDlpMissing={settings.ytDlpMissing} />
      {idle && hasLibrary && <section className="mt-10 border-t border-rule" aria-labelledby="recent-title"><div className="flex items-baseline justify-between gap-4 pt-4"><h2 id="recent-title" className="m-0 text-label font-bold tracking-caps uppercase text-ink">Recent transcripts</h2><button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-fine text-ink-3 underline decoration-dotted decoration-1 underline-offset-[3px] hover:text-ink hover:decoration-solid disabled:cursor-not-allowed disabled:opacity-45" onClick={openLibrary} disabled={wordEditing}>Open library</button></div><ul className="relative mx-0 mt-2 mb-0 list-none p-0 before:absolute before:inset-y-0 before:left-margin before:w-px before:bg-rule before:content-[''] compact:before:hidden">{recent.map((item) => <li key={item.id} className="first:*:border-t-0"><button type="button" className="grid w-full cursor-pointer grid-cols-[154px_minmax(0,1fr)_auto_16px] items-center border-0 border-t border-rule-soft bg-transparent px-0 py-3.25 text-left disabled:cursor-default disabled:opacity-55 compact:grid-cols-[minmax(0,1fr)_auto_16px] compact:gap-y-1 [&_svg]:justify-self-end [&_svg]:text-ink-3 [&_svg]:transition-colors [&_svg]:duration-150 [&_svg]:ease-[ease] enabled:hover:[&_svg]:text-ink enabled:hover:[&>span:nth-child(2)]:underline enabled:hover:[&>span:nth-child(2)]:decoration-1 enabled:hover:[&>span:nth-child(2)]:underline-offset-[3px]" onClick={() => openSaved(item)} disabled={library.openingId !== null || wordEditing}><span className="overflow-hidden pr-5 text-right text-ellipsis whitespace-nowrap font-mono text-micro tracking-[0.01em] text-ink-3 tabular-nums compact:col-span-full compact:p-0 compact:text-left">{savedWhen(item.createdAt)}</span><span className="overflow-hidden pl-5 text-ellipsis whitespace-nowrap text-name font-semibold tracking-name text-ink compact:pl-0">{item.title}</span><span className="whitespace-nowrap pl-4.5 font-mono text-micro tracking-[0.01em] text-ink-3 tabular-nums compact:pl-3">{formatClock(item.duration ?? 0)}<span className="mx-1.5 text-rule">·</span>{formatBytes(item.audioBytes)}</span><ChevronIcon /></button></li>)}</ul></section>}
      <JobProgress phase={job.phase} progress={job.progress} whoProgress={job.whoProgress} steps={steps} />
      {job.error && <section className={ALERT} role="alert"><AlertIcon /><span><strong>Something went wrong</strong><span className="mt-2 mb-0 block whitespace-pre-wrap break-words font-mono text-meta leading-[1.6] text-alert">{job.error}</span><span className="mt-2.5 block text-meta leading-[1.6] text-ink-2">{file ? "Check that the file is a readable video or audio recording and try again." : "Check the link and try again. If yt-dlp is missing, install it from Settings."}</span></span></section>}
      {job.result && <TranscriptWorkspace result={job.result} segments={job.segments} speakerCount={job.speakerCount} whoError={job.whoError} speakerNames={transcriptSession.speakerNames} wordEditing={wordEditing} canEditWords={canEditWords} playback={playback} onCopy={copyTranscript} onExport={exportAs} onRename={transcriptSession.renameSpeaker} onSaveWords={transcriptSession.saveWordCorrections} onEditStateChange={(editing, saving = false, dirty = false) => { wordEditingRef.current = editing; wordSavingRef.current = saving; wordDirtyRef.current = dirty; setWordEditing(editing); }} editButtonRef={editButtonRef} toolbarCancelRef={toolbarCancelRef} toolbarSaveRef={toolbarSaveRef} titleRef={resultTitleRef} />}
      {idle && <section className="mt-11.5 border-t border-rule"><ol className="m-0 grid list-none grid-cols-4 p-0 compact:grid-cols-2 narrow:grid-cols-1">{HOW.map((step) => <li key={step.label} className="pt-4.25 pr-5.5 not-first:border-l not-first:border-rule-soft not-first:pl-5.5 compact:odd:border-l-0 compact:odd:pl-0 compact:nth-[n+3]:pt-5 narrow:odd:border-l-0 narrow:odd:pl-0 narrow:pt-4.5 narrow:nth-3:pt-4.5 narrow:first:pt-4.25"><span className="block text-label font-bold tracking-caps uppercase text-ink">{step.label}</span><span className="mt-2 block text-meta leading-[1.55] text-ink-3">{step.text}</span></li>)}</ol></section>}
      {idle && library.ready && !hasLibrary && <ExampleOutput />}
    </main><footer className="mx-auto mt-13.5 flex w-full max-w-page flex-wrap justify-between gap-4 border-t border-rule px-0 pt-5 pb-7 text-fine text-ink-3 compact:px-7 compact:py-0 narrow:px-5 [&_strong]:font-semibold [&_strong]:text-ink-2"><span>Powered by Desert Ant Labs <strong>Voz</strong> and <strong>Who</strong>.</span><span>Models run on this machine.</span></footer>
    <LibraryDrawer open={libraryOpen} items={library.items} error={library.error} openingId={library.openingId} deletingId={library.deletingId} deleteBusy={library.deleteBusy} savedWhen={savedWhen} onClose={closeLibrary} onOpen={openSaved} onDelete={(item) => library.setDeletingId(item.id)} onCancelDelete={() => library.setDeletingId(null)} onConfirmDelete={deleteSaved} closeRef={libraryCloseRef} />
    <SettingsDrawer open={settingsOpen} busy={busy} speakerLabels={settings.speakerLabels} onToggleSpeakerLabels={settings.toggleSpeakerLabels} tools={settings.tools} updating={settings.updating} updateMessage={settings.updateMessage} updateOk={settings.updateOk} latestYtDlp={settings.latestYtDlp} checkingLatest={settings.checkingLatest} latestError={settings.latestError} upToDate={settings.upToDate} hasUpdate={settings.hasUpdate} onUpdate={settings.updateYtDlp} onClose={closeSettings} closeRef={settingsCloseRef} />
    {notice && <div className="fixed bottom-6.5 left-1/2 z-[120] animate-rise rounded-[10px] border border-rule bg-sheet px-4 py-2.5 text-small text-ink shadow-float [transform:translateX(-50%)] motion-reduce:animate-none">{notice}</div>}
  </div>;
}

function ExampleOutput() { return <section className="relative mt-10.5 border-t border-rule pt-4.5"><p className="mt-0 mb-4 text-label tracking-caps uppercase text-ink-3">Example output</p><div className="relative before:absolute before:inset-y-0 before:left-margin before:w-px before:bg-rule before:content-[''] compact:before:hidden">{[["0:00", "Speaker 1", "Good evening, and welcome to the show."], ["0:05", "Speaker 2", "Thanks for having me. Where should we start?"], ["0:12", "Speaker 1", "Let us start with the question you came to ask."]].map(([time, speaker, text], i) => <div key={time} className="grid grid-cols-[58px_96px_minmax(0,1fr)] items-start not-first:mt-3.5 compact:block"><span className="pt-1.75 pr-5 text-right font-mono text-[11.5px] text-ink-3 tabular-nums compact:inline-block compact:pt-0 compact:pr-3 compact:text-left">{time}</span><span className={`pt-2 pr-5 text-label font-bold tracking-label uppercase ${i === 1 ? "text-pen-2" : "text-pen-1"} compact:inline-block compact:pt-0 compact:pr-3 compact:text-left`}>{speaker}</span><p className="m-0 max-w-[68ch] pl-5 font-text text-prose text-speech text-pretty compact:mt-1.5 compact:pl-0">{text}</p></div>)}</div></section>; }
function formatClock(value: number) { const total = Math.floor(value); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function MarkIcon() { return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" aria-hidden="true"><rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2.25" /><path d="M5.75 6.75h6.5M5.75 9.25h6.5M5.75 11.75h3.5" /></svg>; }
function GearIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>; }
function ChevronIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>; }
