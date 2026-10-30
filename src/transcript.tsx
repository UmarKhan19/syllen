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
