import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryItem } from "../../lib/wire-types";
import { formatBytes } from "../../lib/format-bytes";
import { formatClock } from "../../lib/captions";
import { AlertIcon, CloseIcon, LibraryIcon } from "../../icons";

const FINE = "text-fine leading-[1.6] text-ink-3";
const ALERT =
  "mt-4.5 flex gap-2.75 rounded-card border border-alert-line bg-alert-wash px-4 py-3.25 text-small leading-[1.6] text-ink-2 [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg]:basis-4 [&_strong]:font-semibold [&_svg]:text-alert [&_strong]:text-alert";
const GHOST =
  "cursor-pointer rounded-control border border-rule bg-transparent py-0 text-ink-2 transition-colors duration-150 ease-[ease] enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-45";

export function LibraryDrawer({
  open,
  items,
  error,
  openingId,
  deletingId,
  deleteBusy,
  savedWhen,
  onClose,
  onOpen,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
  closeRef,
}: {
  open: boolean;
  items: LibraryItem[] | null;
  error: string | null;
  openingId: string | null;
  deletingId: string | null;
  deleteBusy: boolean;
  savedWhen: (millis: number) => string;
  onClose: () => void;
  onOpen: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (item: LibraryItem) => void;
  closeRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [query, setQuery] = useState("");
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose, closeRef]);
  useEffect(() => {
    if (deletingId) cancelDeleteRef.current?.focus();
  }, [deletingId]);
  const filtered = useMemo(
    () =>
      items?.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase())) ?? [],
    [items, query],
  );
  const bytes = items?.reduce((sum, item) => sum + item.audioBytes, 0) ?? 0;
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex animate-fade-in justify-end bg-scrim motion-reduce:animate-none">
      <button
        type="button"
        className="absolute inset-0 z-0 h-full w-full cursor-default border-0 bg-transparent p-0"
        aria-label="Close library"
        onClick={onClose}
      />
      <aside
        className="relative z-10 flex h-full w-full max-w-[480px] animate-slide-in flex-col overflow-y-auto border-l border-rule bg-paper px-6.5 pt-6 pb-7.5 shadow-float motion-reduce:animate-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-title"
      >
        <div className="flex items-center justify-between gap-4 pb-4.5">
          <div>
            <h2 id="library-title" className="m-0 text-[19px] font-semibold tracking-[-0.015em]">
              Library
            </h2>
            <p className="mt-1.25 mb-0 font-mono text-micro tracking-[0.02em] text-ink-3 tabular-nums">
              {items === null || items.length === 0
                ? "On this machine"
                : `${items.length} ${items.length === 1 ? "transcript" : "transcripts"} · ${formatBytes(bytes)}`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="grid size-icon shrink-0 cursor-pointer place-items-center rounded-control border border-rule bg-transparent text-ink-2 transition-colors duration-150 ease-[ease] hover:border-rule-strong hover:bg-sheet hover:text-ink"
            onClick={onClose}
            aria-label="Close library"
          >
            <CloseIcon />
          </button>
        </div>
        {items && items.length > 5 && (
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
        {error && (
          <div className={ALERT} role="alert">
            <AlertIcon />
            <span>
              <strong>Library unavailable.</strong> {error}
            </span>
          </div>
        )}
        {items === null ? (
          error ? null : (
            <p className="mt-4 mb-0 text-meta leading-[1.6] text-ink-3" role="status">
              Reading your library…
            </p>
          )
        ) : items.length === 0 ? (
          <div className="border-t border-rule px-4.5 pt-10 pb-8.5 text-center text-ink-3 [&_svg]:size-6.5 [&_strong]:mt-2.5 [&_strong]:block [&_strong]:text-[13.5px] [&_strong]:font-semibold [&_strong]:text-ink [&_p]:mx-auto [&_p]:mt-1.25 [&_p]:mb-0 [&_p]:max-w-[32ch] [&_p]:text-meta [&_p]:leading-[1.6]">
            <LibraryIcon />
            <strong>Nothing saved yet.</strong>
            <p>Finished transcripts and their audio appear here, on this machine.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-4 mb-0 text-meta leading-[1.6] text-ink-3">
            No transcript matches “{query.trim()}”.
          </p>
        ) : (
          <ul className="m-0 list-none border-t border-rule p-0">
            {filtered.map((item) => (
              <li
                key={item.id}
                className={`group flex items-stretch gap-0.5 border-b border-rule-soft last:border-b-0 ${openingId === item.id ? "opacity-55" : ""}`}
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
                        onClick={() => onConfirmDelete(item)}
                        disabled={deleteBusy}
                      >
                        {deleteBusy ? "Deleting…" : "Delete"}
                      </button>
                      <button
                        type="button"
                        className={`${GHOST} h-8 px-3 text-meta`}
                        ref={cancelDeleteRef}
                        onClick={onCancelDelete}
                        disabled={deleteBusy}
                      >
                        Keep
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.25 border-0 bg-transparent py-3.5 pr-2 pl-0 text-left disabled:cursor-default enabled:hover:[&>span:first-child]:underline enabled:hover:[&>span:first-child]:decoration-1 enabled:hover:[&>span:first-child]:underline-offset-[3px]"
                      onClick={() => onOpen(item)}
                      disabled={openingId !== null}
                    >
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-name font-semibold leading-[1.35] tracking-name text-ink">
                        {item.title}
                      </span>
                      <span className="flex flex-wrap items-center font-mono text-micro tracking-[0.01em] text-ink-3 tabular-nums">
                        {savedWhen(item.createdAt)}
                        <span className="mx-1.5 text-rule">·</span>
                        {formatClock(item.duration ?? 0)}
                        {item.speakerCount !== null && item.speakerCount > 0 && (
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
                      onClick={() => onDelete(item)}
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
            Transcripts and audio are stored in this app's data folder. Deleting a transcript
            deletes its audio too.
          </p>
        </div>
      </aside>
    </div>
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
