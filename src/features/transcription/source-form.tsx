import type { FormEvent, RefObject } from "react";
import type { FileInfo } from "../../lib/wire-types";
import { formatBytes } from "../../lib/format-bytes";

type Props = {
  url: string;
  setUrl: (value: string) => void;
  file: (FileInfo & { path: string }) | null;
  prompt: string | null;
  dragging: boolean;
  busy: boolean;
  idle: boolean;
  wordEditing: boolean;
  phase: string;
  onSubmit: (event: FormEvent) => void;
  onPick: () => void;
  onClear: () => void;
  urlRef: RefObject<HTMLInputElement | null>;
  changeRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  missing: string[];
  ytDlpMissing: boolean;
};

const GHOST =
  "cursor-pointer rounded-control border border-rule bg-transparent py-0 text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45";

function fileKind(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

export function SourceForm(props: Props) {
  const {
    url,
    setUrl,
    file,
    prompt,
    dragging,
    busy,
    idle,
    wordEditing,
    phase,
    onSubmit,
    onPick,
    onClear,
    urlRef,
    changeRef,
    onCancel,
    missing,
    ytDlpMissing,
  } = props;
  const height = idle ? "h-control" : "h-control-sm";
  const inset = idle ? "pl-11" : "pl-10.5";
  return (
    <section className="mt-7">
      <form onSubmit={onSubmit} className="flex gap-2.5 narrow:flex-wrap">
        <div
          className={`relative flex min-w-0 flex-1 items-center rounded-card border transition-[border-color,box-shadow,background-color] duration-150 ease-[ease] focus-within:border-ink focus-within:shadow-focus ${dragging ? "border-ink" : "border-rule"} ${dragging || busy ? "bg-wash" : "bg-sheet"} ${height} ${file ? `pr-1.5 ${inset}` : ""} narrow:basis-full`}
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
                onClick={onPick}
                disabled={busy || wordEditing}
                aria-label="Change file"
              >
                Change
              </button>
              <button
                type="button"
                className="grid size-7.5 shrink-0 cursor-pointer place-items-center rounded-inline border-0 bg-transparent p-0 text-ink-3 transition-colors duration-150 ease-[ease] enabled:hover:bg-wash enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
                onClick={onClear}
                disabled={busy || wordEditing}
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
                onChange={(event) => setUrl(event.target.value)}
                placeholder="Paste a YouTube link"
                disabled={busy || wordEditing}
                aria-label="YouTube URL"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                className={`h-full min-w-0 flex-1 rounded-card border-0 bg-transparent py-0 pr-3 text-body text-ink placeholder:text-ink-3 focus:outline-none disabled:text-ink-3 ${inset}`}
              />
              <button
                type="button"
                className={`inline-flex h-full shrink-0 cursor-pointer items-center gap-1.75 whitespace-nowrap rounded-r-card border-0 border-l border-rule bg-transparent py-0 font-medium text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:bg-wash enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:text-ink-3 enabled:hover:[&_svg]:text-ink ${idle ? "px-3.75 text-small" : "px-3.25 text-meta"}`}
                onClick={onPick}
                disabled={busy || wordEditing}
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
            className={`${GHOST} px-3.5 text-small ${height}`}
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : phase === "who" ? (
          <button type="button" className={`${GHOST} px-3.5 text-small ${height}`} disabled>
            Working…
          </button>
        ) : (
          <button
            type="submit"
            className={`cursor-pointer whitespace-nowrap rounded-card border px-6 py-0 text-[14px] font-semibold tracking-[-0.002em] [transition:background-color_0.15s_ease,box-shadow_0.15s_ease,translate_0.05s_ease] active:enabled:translate-y-px disabled:cursor-not-allowed narrow:w-full ${height} ${idle ? "border-ink bg-ink text-on-ink enabled:hover:bg-ink-deep enabled:hover:shadow-button-hover disabled:border-transparent disabled:bg-disabled disabled:text-disabled-ink" : "border-rule bg-transparent text-ink enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:shadow-none"}`}
            disabled={wordEditing}
          >
            Transcribe
          </button>
        )}
      </form>
      {prompt && (
        <p className="mx-0.5 mt-2.5 mb-0 text-meta leading-[1.55] text-ink-2" role="status">
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
        <div className="mt-4.5 flex gap-2.75 rounded-card border border-rule bg-sheet px-4 py-3.25 text-small leading-[1.6] text-ink-2 [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg]:basis-4 [&_strong]:font-semibold [&_strong]:text-ink [&_svg]:text-ink-3 [&_code]:rounded-[5px] [&_code]:bg-wash [&_code]:px-1.25 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:whitespace-nowrap">
          <InfoIcon />
          <span>
            <strong>Missing tools:</strong> {missing.join(", ")}. The app looks in its app-data
            folder and <code>src-tauri/resources/bin</code>, then in your PATH.
          </span>
        </div>
      )}
      {ytDlpMissing && (
        <div className="mt-4.5 flex gap-2.75 rounded-card border border-rule bg-sheet px-4 py-3.25 text-small leading-[1.6] text-ink-2 [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg]:basis-4 [&_strong]:font-semibold [&_strong]:text-ink [&_svg]:text-ink-3">
          <InfoIcon />
          <span>
            <strong>YouTube links need yt-dlp.</strong> Install it from Settings, or choose a video
            or audio file — file uploads do not need it.
          </span>
        </div>
      )}
    </section>
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
