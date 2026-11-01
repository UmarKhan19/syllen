import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  formatClock,
  isPunctuation,
  speakerLabel,
  type Segment,
} from "./lib/merge";

/* Colour means a person: the four pens, modulo the speaker id. */
const speakerInk = ["text-pen-1", "text-pen-2", "text-pen-3", "text-pen-4"];

/* The ruled margin down the sheet, at the speech column or the timecode one. */
const transcriptRule =
  "relative mt-2 before:absolute before:inset-y-0 before:w-px before:bg-rule compact:before:hidden";

const paraFrame = "grid items-start py-1.75 scroll-mt-sticky compact:block";
const paraColumns = "grid-cols-[58px_96px_minmax(0,1fr)]";
const paraColumnsPlain = "grid-cols-[58px_minmax(0,1fr)]";

const timeBase =
  "pt-1.75 pr-5 pb-0 pl-0 text-right font-mono text-[11.5px] tabular-nums compact:inline-block compact:pt-0 compact:pr-3 compact:text-left";

const whoBase =
  "pt-2 pr-5 pb-0 pl-0 text-label font-bold tracking-label uppercase compact:inline-block compact:pt-0 compact:pr-3 compact:text-left";

const speechFrame = "pl-5 compact:block compact:mt-1.5 compact:pl-0";

const proseBase =
  "m-0 max-w-[92ch] font-text text-prose text-speech text-pretty";

/* The inline rename buttons sit on the ghost control, 36px inside the editor. */
const ghostBase =
  "h-9 px-3 py-0 border rounded-control text-[12px] cursor-pointer transition-colors ease-[ease] disabled:opacity-45 disabled:cursor-not-allowed";

export const Transcript = memo(function Transcript({
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
      <div className={`${transcriptRule} before:left-margin`} ref={containerRef}>
        <p className={`${proseBase} pt-4.5`}>{fallback}</p>
      </div>
    );
  }
  const labelled = segments.some((segment) => segment.speaker !== null);
  return (
    <div
      className={`${transcriptRule} ${labelled ? "before:left-margin" : "before:left-[58px]"}`}
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
              className={`${paraFrame} ${paraColumns}${startsTurn ? " mt-7.5 first:mt-3" : ""}`}
              data-para-index={index}
              key={`${segment.start}-${index}`}
            >
              <TimeCode
                start={segment.start}
                onSeek={onSeek}
                current={active.segment === index}
              />
              <form
                className="relative z-[1] col-start-2 col-end-[-1] bg-paper pt-1.25 pr-0 pb-2 pl-0 compact:py-2"
                onSubmit={saveName}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeEditor();
                  }
                }}
              >
                <div className="flex items-center gap-2 max-w-[520px] compact:max-w-full">
                  <input
                    ref={inputRef}
                    type="text"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    aria-label={`Name for ${label}`}
                    maxLength={48}
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 h-9 px-2.5 py-0 border border-rule rounded-control bg-sheet text-small focus:outline-none focus:border-ink focus:shadow-focus"
                  />
                  <button
                    type="submit"
                    className={`${ghostBase} border-ink bg-ink text-paper enabled:hover:border-ink-deep enabled:hover:bg-ink-deep`}
                    disabled={!draftName.trim()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className={`${ghostBase} border-rule bg-transparent text-ink-2 enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink`}
                    onClick={closeEditor}
                  >
                    Cancel
                  </button>
                </div>
                <p className="mt-1.5 mb-0 text-[11.5px] leading-[1.45] text-ink-3">
                  Changes all {speakerCounts[speaker] ?? 0} transcript{" "}
                  {(speakerCounts[speaker] ?? 0) === 1 ? "passage" : "passages"} and
                  export labels.
                </p>
              </form>
              <div className="col-start-2 col-end-[-1] mt-2.5">
                <p className={proseBase}>{segment.text}</p>
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
            labelled={labelled}
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
  labelled,
  current,
  activeWord,
  label,
  onSeek,
  onBeginEdit,
}: {
  segment: Segment;
  index: number;
  startsTurn: boolean;
  labelled: boolean;
  current: boolean;
  activeWord: number;
  label: string;
  onSeek?: (seconds: number) => void;
  onBeginEdit: (index: number, label: string) => void;
}) {
  const speaker = segment.speaker;
  return (
    <div
      className={`${paraFrame} ${labelled ? paraColumns : paraColumnsPlain}${startsTurn ? " mt-7.5 first:mt-3" : ""}`}
      data-para-index={index}
      aria-current={current ? "true" : undefined}
    >
      <TimeCode start={segment.start} onSeek={onSeek} current={current} />
      {startsTurn && speaker !== null ? (
        <button
          type="button"
          className={`group inline-flex items-center gap-1.25 max-w-full min-h-7 pt-2 pr-1 pb-0 pl-0 overflow-hidden border-0 bg-transparent text-left whitespace-nowrap cursor-pointer text-label font-bold tracking-label uppercase compact:inline-block compact:pt-0 compact:pr-3 ${speakerTone(speaker)}`}
          onClick={() => onBeginEdit(index, label)}
          data-segment-index={index}
          aria-label={`Rename ${label}`}
          title={`Rename ${label}`}
        >
          <span className="overflow-hidden text-ellipsis group-hover:underline group-hover:underline-offset-[3px]">
            {label}
          </span>
          <PencilIcon />
        </button>
      ) : (
        <span
          className={
            labelled
              ? `${whoBase} ${speakerTone(speaker)}${
                  startsTurn
                    ? ""
                    : " before:block before:w-px before:h-3.25 before:mt-0.5 before:ml-px before:bg-rule compact:before:hidden"
                }`
              : "hidden"
          }
        />
      )}
      <div className={speechFrame}>
        <p className={proseBase}>
          <span className={current ? "bg-read rounded-[2px] box-decoration-clone" : undefined}>
            {segment.words.map((word, wordIndex) => (
              <span
                key={`${word.start}-${wordIndex}`}
                className={
                  current && activeWord === wordIndex
                    ? onSeek
                      ? "rounded-[2px] bg-word shadow-[0_0_0_2px_var(--word)] cursor-pointer"
                      : "rounded-[2px] bg-word shadow-[0_0_0_2px_var(--word)]"
                    : onSeek
                      ? "cursor-pointer hover:rounded-[2px] hover:bg-word-hover hover:shadow-[0_0_0_2px_var(--word-hover)]"
                      : undefined
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
  current,
}: {
  start: number;
  onSeek?: (seconds: number) => void;
  current: boolean;
}) {
  const text = formatClock(start);
  const tone = current ? "text-ink" : "text-ink-3";
  if (!onSeek) return <span className={`${timeBase} ${tone}`}>{text}</span>;
  return (
    <button
      type="button"
      className={`${timeBase} ${tone} border-0 bg-transparent cursor-pointer hover:text-ink hover:underline hover:decoration-dotted hover:decoration-[1px] hover:underline-offset-[3px]`}
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
      className="shrink-0 grow-0 basis-3 opacity-[0.55] group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      <path d="m10.9 2.2 2.9 2.9M2.4 13.6l2.8-.6 8-8a1.3 1.3 0 0 0-1.8-1.8l-8 8-.6 2.4Z" />
    </svg>
  );
}

function speakerTone(speaker: number | null): string {
  return speaker === null
    ? "text-ink-3"
    : (speakerInk[speaker % 4] ?? "text-ink-3");
}
