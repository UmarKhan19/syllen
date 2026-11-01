import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
  type FormEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  formatClock,
  isPunctuation,
  replaceWordText,
  sameWordTexts,
  speakerLabel,
  type Segment,
  type Word,
} from "./lib/merge";
import { WordCorrectionPopover } from "./wordCorrectionPopover";

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
  onSaveWords: (
    expected: Word[],
    corrected: Word[],
    segments: Segment[],
  ) => Promise<void>;
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
  const [draftName, setDraftName] = useState("");
  const [draftSegments, setDraftSegments] = useState<Segment[] | null>(null);
  const [editingWord, setEditingWord] = useState<{
    segment: number;
    word: number;
  } | null>(null);
  const [wordDraft, setWordDraft] = useState("");
  const [wordError, setWordError] = useState<string | null>(null);
  const [savingWords, setSavingWords] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusIndexRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wordInputRef = useRef<HTMLInputElement>(null);
  const wordAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [wordFocusToken, setWordFocusToken] = useState(0);
  const editingWords = draftSegments !== null;
  const renderedSegments = draftSegments ?? segments;
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
  const originalWords = useMemo(() => segments.flatMap((segment) => segment.words), [segments]);
  const draftWords = useMemo(
    () => renderedSegments.flatMap((segment) => segment.words),
    [renderedSegments],
  );
  const hasWordChanges =
    editingWords &&
    (!sameWordTexts(originalWords, draftWords) ||
      (editingWord !== null &&
        wordDraft !== renderedSegments[editingWord.segment]?.words[editingWord.word]?.text));

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
    if (editingWord !== null) {
      wordInputRef.current?.focus();
      wordInputRef.current?.select();
    }
  }, [editingWord]);

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

  const beginWordEdit = useCallback(() => {
    setDraftSegments(
      segments.map((segment) => ({
        ...segment,
        words: segment.words.map((word) => ({ ...word })),
      })),
    );
    setEditingWord(null);
    setWordError(null);
    onEditStateChange(true);
    onFollowOff();
    requestAnimationFrame(() => toolbarCancelRef.current?.focus({ preventScroll: true }));
  }, [onEditStateChange, onFollowOff, segments, toolbarCancelRef]);

  const applyWord = useCallback(
    (restoreFocus = false): Segment[] | null => {
      if (!draftSegments) return null;
      if (!editingWord) return draftSegments;
      try {
        const corrected = replaceWordText(
          draftSegments,
          editingWord.segment,
          editingWord.word,
          wordDraft,
        );
        setDraftSegments(corrected);
        setEditingWord(null);
        setWordError(null);
        onEditStateChange(true, savingWords, !sameWordTexts(
          originalWords,
          corrected.flatMap((segment) => segment.words),
        ));
        if (restoreFocus) {
          requestAnimationFrame(() => wordAnchorRef.current?.focus({ preventScroll: true }));
        }
        return corrected;
      } catch (problem) {
        setWordError(String(problem).replace(/^Error: /, ""));
        requestAnimationFrame(() => wordInputRef.current?.focus());
        return null;
      }
    },
    [draftSegments, editingWord, onEditStateChange, originalWords, savingWords, wordDraft],
  );

  const beginWord = useCallback(
    (index: number, wordIndex: number, word: Word, anchor: HTMLButtonElement) => {
      if (editingWord?.segment === index && editingWord.word === wordIndex) {
        wordAnchorRef.current = anchor;
        setWordFocusToken((token) => token + 1);
        return;
      }
      if (editingWord !== null && !applyWord()) return;
      wordAnchorRef.current = anchor;
      setWordDraft(word.text);
      setWordError(null);
      setEditingWord({ segment: index, word: wordIndex });
      setWordFocusToken((token) => token + 1);
    },
    [applyWord, editingWord],
  );

  const cancelWordEdits = useCallback(() => {
    if (savingWords) return;
    setDraftSegments(null);
    setEditingWord(null);
    wordAnchorRef.current = null;
    setWordError(null);
    onEditStateChange(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }, [editButtonRef, onEditStateChange, savingWords]);

  const cancelWordInput = useCallback(() => {
    const target = wordAnchorRef.current;
    setEditingWord(null);
    wordAnchorRef.current = null;
    setWordError(null);
    if (draftSegments) {
      onEditStateChange(
        true,
        savingWords,
        !sameWordTexts(originalWords, draftSegments.flatMap((segment) => segment.words)),
      );
    }
    if (target) {
      requestAnimationFrame(() => target.focus({ preventScroll: true }));
    }
  }, [draftSegments, onEditStateChange, originalWords, savingWords]);

  const updateWordDraft = useCallback((text: string) => {
    setWordDraft(text);
    const target = editingWord
      ? renderedSegments[editingWord.segment]?.words[editingWord.word]?.text
      : undefined;
    onEditStateChange(
      true,
      savingWords,
      !sameWordTexts(originalWords, draftWords) || text !== target,
    );
  }, [draftWords, editingWord, onEditStateChange, originalWords, renderedSegments, savingWords]);

  async function saveWordEdits() {
    if (!draftSegments || savingWords) return;
    const applied = applyWord();
    if (!applied) return;
    const corrected = applied.flatMap((segment) => segment.words);
    const original = segments.flatMap((segment) => segment.words);
    if (sameWordTexts(original, corrected)) return;
    setSavingWords(true);
    onEditStateChange(true, true, hasWordChanges);
    setWordError(null);
    let saved = false;
    try {
      await onSaveWords(original, corrected, applied);
      saved = true;
      setDraftSegments(null);
      setEditingWord(null);
      wordAnchorRef.current = null;
      onEditStateChange(false);
      requestAnimationFrame(() => editButtonRef.current?.focus());
    } catch (problem) {
      setWordError(String(problem));
    } finally {
      setSavingWords(false);
      if (!saved) onEditStateChange(true, false, true);
    }
  }

  if (segments.length === 0) {
    return (
      <div className="transcript" ref={containerRef}>
        <p className="plain">{fallback}</p>
      </div>
    );
  }
  const labelled = segments.some((segment) => segment.speaker !== null);
  const editingLabel = editingWord
    ? renderedSegments[editingWord.segment]?.words[editingWord.word]?.text ?? "word"
    : "word";
  return (
    <>
      {canEditWords && actionHost && createPortal(
        editingWords ? (
          <>
            <div className="wordCorrectionActions">
              <button
                ref={toolbarCancelRef}
                type="button"
                className="ghost"
                data-word-correction-action="cancel"
                onClick={cancelWordEdits}
                disabled={savingWords}
              >
                Cancel
              </button>
              <button
                ref={toolbarSaveRef}
                type="button"
                className="btn wordCorrectionSave"
                data-word-correction-action="save"
                onClick={saveWordEdits}
                disabled={savingWords || !hasWordChanges}
              >
                {savingWords ? "Saving…" : "Save changes"}
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              ref={editButtonRef}
              type="button"
              className="iconButton wordCorrectionToggle"
              aria-label="Edit words"
              aria-describedby="edit-words-tooltip"
              onClick={beginWordEdit}
              disabled={editingIndex !== null}
            >
              <PencilIcon />
              <span id="edit-words-tooltip" className="controlTooltip" role="tooltip">
                Edit words
              </span>
            </button>
            {editingIndex !== null && (
              <span className="wordCorrectionHint wordRenameHint">
                Finish speaker renaming first.
              </span>
            )}
          </>
        ),
        actionHost,
      )}
      {canEditWords && errorHost && wordError && createPortal(
        <span id="word-correction-error" className="wordCorrectionError" role="alert">
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
        className={`transcript${labelled ? "" : " unlabelled"}${onSeek ? " seekable" : ""}`}
        ref={containerRef}
      >
      {renderedSegments.map((segment, index) => {
        const startsTurn =
          index === 0 || segment.speaker !== segments[index - 1].speaker;
        const speaker = segment.speaker;
        const label = speakerLabel(speaker, speakerNames);
        const editing = editingIndex === index && speaker !== null && !editingWords;

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
            editingWords={editingWords}
            editingWord={editingWord?.segment === index ? editingWord.word : null}
            onBeginWord={beginWord}
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
  current,
  activeWord,
  label,
  onSeek,
  onBeginEdit,
  editingWords,
  editingWord,
  onBeginWord,
}: {
  segment: Segment;
  index: number;
  startsTurn: boolean;
  current: boolean;
  activeWord: number;
  label: string;
  onSeek?: (seconds: number) => void;
  onBeginEdit: (index: number, label: string) => void;
  editingWords: boolean;
  editingWord: number | null;
  onBeginWord: (
    index: number,
    wordIndex: number,
    word: Word,
    anchor: HTMLButtonElement,
  ) => void;
}) {
  const speaker = segment.speaker;
  return (
    <div
      className={`para ${startsTurn ? "turn-start" : "turn-continue"}${current ? " current" : ""}`}
      data-para-index={index}
      aria-current={current ? "true" : undefined}
    >
      <TimeCode start={segment.start} onSeek={onSeek} />
      {startsTurn && speaker !== null && !editingWords ? (
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
            {segment.words.map((word, wordIndex) => {
              const prefix = wordIndex > 0 && !isPunctuation(word.text) ? " " : null;
              if (editingWords) {
                return (
                  <Fragment key={`${word.start}-${wordIndex}`}>
                    {prefix}
                    <button
                      type="button"
                      className={`word wordCorrectionTarget${editingWord === wordIndex ? " selected" : ""}`}
                      data-word-segment={index}
                      data-word-index={wordIndex}
                      data-word-correction-target
                      aria-pressed={editingWord === wordIndex}
                      aria-label={`Edit word ${word.text} at ${formatClock(word.start)}`}
                      onClick={(event) => onBeginWord(index, wordIndex, word, event.currentTarget)}
                    >
                      {word.text}
                    </button>
                  </Fragment>
                );
              }
              return (
                <span
                  key={`${word.start}-${wordIndex}`}
                  className={current && activeWord === wordIndex ? "word active" : "word"}
                  onClick={
                    onSeek
                      ? (event) => {
                          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
                          if (window.getSelection()?.isCollapsed === false) return;
                          onSeek(word.start);
                        }
                      : undefined
                  }
                >
                  {prefix}{word.text}
                </span>
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
