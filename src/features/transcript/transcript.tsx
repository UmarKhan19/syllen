import {
  type FormEvent,
  Fragment,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { formatClock } from "../../lib/captions";
import { isPunctuation, type Segment, speakerLabel, type Word } from "../../lib/transcript";
import { useWordCorrections } from "./use-word-corrections";
import { WordCorrectionPopover } from "./word-correction-popover";
import { wordNavigationTarget, wordTabStopIndex } from "./word-navigation";

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

const proseBase = "m-0 max-w-[92ch] font-text text-prose text-speech text-pretty";

/* Word-correction targets inherit the prose face; only the box is reset. */
const wordEditFrame =
  "max-w-full p-0 border-0 rounded-[2px] text-left whitespace-normal wrap-anywhere align-baseline";

/* The inline rename buttons sit on the ghost control, 36px inside the editor. */
const ghostBase =
  "h-9 px-3 py-0 border rounded-control text-[12px] cursor-pointer transition-colors ease-[ease] disabled:opacity-45 disabled:cursor-not-allowed";

export const Transcript = memo(function Transcript({
  segments,
  fallback,
  speakerNames,
  onRename,
  canEditWords,
  onSaveWords,
  onEditStateChange,
  actionHost,
  errorHost,
  editButtonRef,
  toolbarCancelRef,
  toolbarSaveRef,
  active,
  onSeek,
  follow,
  onFollowOff,
}: {
  segments: Segment[];
  fallback: string;
  speakerNames: Record<number, string>;
  onRename: (speaker: number, name: string) => void;
  canEditWords: boolean;
  onSaveWords: (expected: Word[], corrected: Word[], segments: Segment[]) => Promise<void>;
  onEditStateChange: (editing: boolean, saving?: boolean, dirty?: boolean) => void;
  actionHost: HTMLDivElement | null;
  errorHost: HTMLDivElement | null;
  editButtonRef: RefObject<HTMLButtonElement | null>;
  toolbarCancelRef: RefObject<HTMLButtonElement | null>;
  toolbarSaveRef: RefObject<HTMLButtonElement | null>;
  active: { segment: number; word: number };
  onSeek?: (seconds: number) => void;
  follow: boolean;
  onFollowOff: () => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [focusedWord, setFocusedWord] = useState({ segment: 0, word: 0 });
  const [draftName, setDraftName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusIndexRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    editingWords,
    renderedSegments,
    editingWord,
    wordDraft,
    wordError,
    savingWords,
    wordInputRef,
    wordAnchorRef,
    wordFocusToken,
    hasWordChanges,
    beginWordEdit,
    applyWord,
    beginWord,
    cancelWordEdits,
    cancelWordInput,
    updateWordDraft,
    saveWordEdits,
  } = useWordCorrections({
    segments,
    onSaveWords,
    onEditStateChange,
    onFollowOff,
    editButtonRef,
    toolbarCancelRef,
  });
  const wordCounts = useMemo(
    () => renderedSegments.map((item) => item.words.length),
    [renderedSegments],
  );
  const handleWordKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, segmentIndex: number, wordIndex: number) => {
      if (!onSeek && !editingWords) return;
      const target = wordNavigationTarget(event.key, segmentIndex, wordIndex, wordCounts);
      if (!target) return;
      event.preventDefault();
      setFocusedWord(target);
      containerRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-word-segment="${target.segment}"][data-word-index="${target.word}"]`,
        )
        ?.focus();
    },
    [editingWords, onSeek, wordCounts],
  );
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
      document.querySelector<HTMLButtonElement>(`[data-segment-index="${index}"]`)?.focus();
    }
  }, [editingIndex]);

  useEffect(() => {
    if (!follow || editingWords || segments.length === 0 || active.segment < 0) return;
    const element = containerRef.current?.querySelector<HTMLElement>(
      `[data-para-index="${active.segment}"]`,
    );
    element?.scrollIntoView({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [active.segment, editingWords, follow, reduceMotion, segments.length]);

  useEffect(() => {
    if (!follow || segments.length === 0) return;
    const stop = () => onFollowOff();
    const onKey = (event: KeyboardEvent) => {
      if (!["PageDown", "PageUp", "Home", "End"].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, button, canvas, [contenteditable='true']")) {
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
  const editingLabel = editingWord
    ? (renderedSegments[editingWord.segment]?.words[editingWord.word]?.text ?? "word")
    : "word";
  return (
    <>
      {canEditWords &&
        actionHost &&
        createPortal(
          editingWords ? (
            <div className="flex flex-none gap-1.5">
              <button
                ref={toolbarCancelRef}
                type="button"
                className="h-8 px-2.25 py-0 border border-rule rounded-control bg-transparent text-ink-2 text-fine whitespace-nowrap cursor-pointer [transition:background_.15s_ease,border-color_.15s_ease,color_.15s_ease] enabled:hover:border-rule-strong enabled:hover:bg-sheet enabled:hover:text-ink disabled:opacity-45 disabled:cursor-not-allowed"
                data-word-correction-action="cancel"
                onClick={cancelWordEdits}
                disabled={savingWords}
              >
                Cancel
              </button>
              <button
                ref={toolbarSaveRef}
                type="button"
                className="h-8 px-2.25 py-0 border border-ink rounded-card bg-ink text-on-ink text-fine font-semibold tracking-[-0.002em] whitespace-nowrap cursor-pointer [transition:background_.15s_ease,box-shadow_.15s_ease,transform_.05s_ease] enabled:hover:bg-ink-deep enabled:hover:shadow-button-hover enabled:active:[transform:translateY(1px)] disabled:border-transparent disabled:bg-disabled disabled:text-disabled-ink disabled:cursor-not-allowed disabled:opacity-45"
                data-word-correction-action="save"
                onClick={saveWordEdits}
                disabled={savingWords || !hasWordChanges}
              >
                {savingWords ? "Saving…" : "Save changes"}
              </button>
            </div>
          ) : (
            <>
              <button
                ref={editButtonRef}
                type="button"
                className="group relative grid h-9 w-9 grow-0 shrink-0 basis-9 place-items-center rounded-none border-0 bg-transparent p-0 text-ink-2 cursor-pointer [transition:color_.15s_ease,background_.15s_ease,border-color_.15s_ease] hover:bg-sheet hover:text-ink enabled:hover:bg-wash focus-visible:z-[2] focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-3 disabled:opacity-45 disabled:cursor-not-allowed"
                aria-label="Edit words"
                aria-describedby="edit-words-tooltip"
                onClick={beginWordEdit}
                disabled={editingIndex !== null}
              >
                <PencilIcon />
                <span
                  id="edit-words-tooltip"
                  className="pointer-events-none invisible absolute top-full right-0 z-50 mt-1.75 rounded-[5px] border border-rule bg-sheet px-2 py-1.25 text-fine font-normal leading-[1.3] whitespace-nowrap text-ink-2 opacity-0 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
                  role="tooltip"
                >
                  Edit words
                </span>
              </button>
              {editingIndex !== null && (
                <span className="m-0 max-w-[120px] text-fine leading-[1.25] whitespace-normal text-ink-3">
                  Finish speaker renaming first.
                </span>
              )}
            </>
          ),
          actionHost,
        )}
      {canEditWords &&
        errorHost &&
        wordError &&
        createPortal(
          <span
            id="word-correction-error"
            className="m-0 block text-fine leading-[1.4] whitespace-normal wrap-anywhere text-alert"
            role="alert"
          >
            Not saved: {wordError}
          </span>,
          errorHost,
        )}
      {editingWord !== null && wordAnchorRef.current && (
        <WordCorrectionPopover
          anchor={wordAnchorRef.current}
          focusToken={wordFocusToken}
          inputRef={wordInputRef}
          cancelRef={toolbarCancelRef}
          value={wordDraft}
          label={editingLabel}
          error={wordError}
          onChange={updateWordDraft}
          onApply={applyWord}
          onCancel={cancelWordInput}
        />
      )}
      <div
        className={`${transcriptRule} ${labelled ? "before:left-margin" : "before:left-[58px]"}`}
        ref={containerRef}
      >
        {renderedSegments.map((segment, index) => {
          const startsTurn = index === 0 || segment.speaker !== segments[index - 1].speaker;
          const speaker = segment.speaker;
          const label = speakerLabel(speaker, speakerNames);
          const editing = editingIndex === index && speaker !== null && !editingWords;

          if (editing) {
            return (
              <div
                className={`${paraFrame} ${paraColumns}${startsTurn ? " mt-7.5 first:mt-3" : ""}`}
                data-para-index={index}
                key={`${segment.start}-${segment.end}`}
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
                    {(speakerCounts[speaker] ?? 0) === 1 ? "passage" : "passages"} and export
                    labels.
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
              key={`${segment.start}-${segment.end}`}
              segment={segment}
              index={index}
              startsTurn={startsTurn}
              labelled={labelled}
              current={active.segment === index}
              activeWord={active.segment === index ? active.word : -1}
              label={label}
              onSeek={onSeek}
              onBeginEdit={beginEdit}
              editingWords={editingWords}
              editingWord={editingWord?.segment === index ? editingWord.word : null}
              onBeginWord={beginWord}
              focusedWord={focusedWord}
              onWordFocus={setFocusedWord}
              onWordKeyDown={handleWordKeyDown}
            />
          );
        })}
      </div>
    </>
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
  editingWords,
  editingWord,
  onBeginWord,
  focusedWord,
  onWordFocus,
  onWordKeyDown,
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
  editingWords: boolean;
  editingWord: number | null;
  onBeginWord: (index: number, wordIndex: number, word: Word, anchor: HTMLButtonElement) => void;
  focusedWord: { segment: number; word: number };
  onWordFocus: (target: { segment: number; word: number }) => void;
  onWordKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    segment: number,
    word: number,
  ) => void;
}) {
  const speaker = segment.speaker;
  const tabStopWord = wordTabStopIndex(index, segment.words.length, focusedWord);
  return (
    <div
      className={`${paraFrame} ${labelled ? paraColumns : paraColumnsPlain}${startsTurn ? " mt-7.5 first:mt-3" : ""}`}
      data-para-index={index}
      aria-current={current ? "true" : undefined}
    >
      <TimeCode start={segment.start} onSeek={onSeek} current={current} />
      {startsTurn && speaker !== null && !editingWords ? (
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
          <PencilIcon className="shrink-0 grow-0 basis-3 opacity-[0.55] group-hover:opacity-100 group-focus-visible:opacity-100" />
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
            {segment.words.map((word, wordIndex) => {
              const prefix = wordIndex > 0 && !isPunctuation(word.text) ? " " : null;
              if (editingWords) {
                return (
                  <Fragment key={`${word.start}-${word.end}`}>
                    {prefix}
                    <button
                      type="button"
                      className={`${wordEditFrame} ${onSeek ? "cursor-pointer" : "cursor-text"} ${
                        editingWord === wordIndex
                          ? onSeek
                            ? "bg-word shadow-[0_0_0_2px_var(--word)] hover:bg-word-hover hover:shadow-[0_0_0_2px_var(--word-hover)]"
                            : "bg-word shadow-[0_0_0_2px_var(--word)]"
                          : "bg-transparent hover:bg-word-hover hover:shadow-[0_0_0_2px_var(--word-hover)]"
                      }`}
                      data-word-index={wordIndex}
                      data-word-correction-target
                      aria-pressed={editingWord === wordIndex}
                      aria-label={`Edit word ${word.text} at ${formatClock(word.start)}`}
                      tabIndex={wordIndex === tabStopWord ? 0 : -1}
                      data-word-segment={index}
                      onFocus={() => onWordFocus({ segment: index, word: wordIndex })}
                      onKeyDown={(event) => onWordKeyDown(event, index, wordIndex)}
                      onClick={(event) => onBeginWord(index, wordIndex, word, event.currentTarget)}
                    >
                      {word.text}
                    </button>
                  </Fragment>
                );
              }
              if (!onSeek) {
                return (
                  <Fragment key={`${word.start}-${word.end}`}>
                    {prefix}
                    <span
                      className={
                        current && activeWord === wordIndex
                          ? "rounded-[2px] bg-word shadow-[0_0_0_2px_var(--word)]"
                          : undefined
                      }
                    >
                      {word.text}
                    </span>
                  </Fragment>
                );
              }
              return (
                <Fragment key={`${word.start}-${word.end}`}>
                  {prefix}
                  <button
                    type="button"
                    data-word-segment={index}
                    data-word-index={wordIndex}
                    tabIndex={wordIndex === tabStopWord ? 0 : -1}
                    onFocus={() => onWordFocus({ segment: index, word: wordIndex })}
                    onKeyDown={(event) => onWordKeyDown(event, index, wordIndex)}
                    className={
                      current && activeWord === wordIndex
                        ? "inline border-0 bg-transparent p-0 align-baseline rounded-[2px] bg-word shadow-[0_0_0_2px_var(--word)] cursor-pointer"
                        : "inline border-0 bg-transparent p-0 align-baseline cursor-pointer hover:rounded-[2px] hover:bg-word-hover hover:shadow-[0_0_0_2px_var(--word-hover)]"
                    }
                    onClick={(event) => {
                      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
                      if (event.detail !== 0 && window.getSelection()?.isCollapsed === false)
                        return;
                      onSeek(word.start);
                    }}
                  >
                    {word.text}
                  </button>
                </Fragment>
              );
            })}
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

function PencilIcon({ className }: { className?: string }) {
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
      className={className}
    >
      <path d="m10.9 2.2 2.9 2.9M2.4 13.6l2.8-.6 8-8a1.3 1.3 0 0 0-1.8-1.8l-8 8-.6 2.4Z" />
    </svg>
  );
}

function speakerTone(speaker: number | null): string {
  return speaker === null ? "text-ink-3" : (speakerInk[speaker % 4] ?? "text-ink-3");
}
