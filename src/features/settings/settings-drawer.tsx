import { useEffect } from "react";
import type { RefObject } from "react";
import type { ToolsStatus } from "../../lib/wire-types";
import { CloseIcon } from "../../icons";

const FINE = "text-fine leading-[1.6] text-ink-3";
const GHOST =
  "cursor-pointer rounded-control border border-rule bg-transparent py-0 text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45";
const CHIP =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-rule bg-sheet px-2.25 py-0.75 text-[11.5px] leading-[1.3]";

export function SettingsDrawer({
  open,
  busy,
  speakerLabels,
  onToggleSpeakerLabels,
  tools,
  updating,
  updateMessage,
  updateOk,
  latestYtDlp,
  checkingLatest,
  latestError,
  upToDate,
  hasUpdate,
  onUpdate,
  onClose,
  closeRef,
}: {
  open: boolean;
  busy: boolean;
  speakerLabels: boolean;
  onToggleSpeakerLabels: () => void;
  tools: ToolsStatus | null;
  updating: boolean;
  updateMessage: string | null;
  updateOk: boolean;
  latestYtDlp: string | null;
  checkingLatest: boolean;
  latestError: string | null;
  upToDate: boolean;
  hasUpdate: boolean;
  onUpdate: () => void;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose, closeRef]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in justify-end bg-scrim motion-reduce:animate-none"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="flex h-full w-full max-w-[420px] animate-slide-in flex-col overflow-y-auto border-l border-rule bg-paper px-6.5 pt-6 pb-7.5 shadow-float motion-reduce:animate-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="flex items-center justify-between gap-4 pb-4.5">
          <h2 id="settings-title" className="m-0 text-[19px] font-semibold tracking-[-0.015em]">
            Settings
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="grid size-icon shrink-0 cursor-pointer place-items-center rounded-control border border-rule bg-transparent text-ink-2 transition-colors duration-150 ease-[ease] hover:border-rule-strong hover:bg-sheet hover:text-ink"
            onClick={onClose}
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>
        <section className="flex items-start justify-between gap-4.5 border-t border-rule py-5">
          <div>
            <h3 className="mt-0 mb-1.5 text-[14px] font-semibold">Speaker labeling</h3>
            <p className="m-0 text-meta leading-[1.6] text-ink-2">
              Use Who to label who said what. Adds a 32 MB model on first use; it runs in a
              background worker, so the window stays responsive.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={speakerLabels}
            aria-label="Speaker labeling"
            className={`h-6 w-10.5 shrink-0 cursor-pointer rounded-full border p-0.5 transition-[background-color,border-color] duration-[180ms] ease-[ease] disabled:cursor-not-allowed disabled:opacity-45 ${speakerLabels ? "border-ink bg-ink" : "border-rule bg-sheet"}`}
            onClick={onToggleSpeakerLabels}
            disabled={busy}
          >
            <span
              className={`block size-4.5 rounded-full [transition:translate_0.18s_cubic-bezier(0.22,0.61,0.36,1),background-color_0.18s_ease] ${speakerLabels ? "translate-x-4.5 bg-paper" : "bg-ink-3"}`}
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
            onClick={onUpdate}
            disabled={busy || updating}
          >
            {updating ? "Updating…" : "Update yt-dlp"}
          </button>
          <p className={`m-0 ${FINE}`}>
            YouTube changes often. This downloads the latest official yt-dlp into the app's data
            folder and uses that copy; your system install is left untouched.
          </p>
          {updateMessage && (
            <pre
              className={`m-0 max-h-47.5 w-full overflow-auto whitespace-pre-wrap break-words rounded-control border bg-sheet px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] ${updateOk ? "border-ok-line text-ok" : "border-alert-line text-alert"}`}
            >
              {updateMessage}
            </pre>
          )}
        </section>
        {busy && <p className={FINE}>Finish the current transcription to change these settings.</p>}
        <div className="mt-auto border-t border-rule pt-5">
          <p className={FINE}>Settings apply to the next transcription.</p>
        </div>
      </aside>
    </div>
  );
}
