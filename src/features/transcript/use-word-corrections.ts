import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { replaceWordText, sameWordTexts, type Segment, type Word } from "../../lib/transcript";

export function useWordCorrections({
  segments,
  onSaveWords,
  onEditStateChange,
  onFollowOff,
  editButtonRef,
  toolbarCancelRef,
}: {
  segments: Segment[];
  onSaveWords: (expected: Word[], corrected: Word[], segments: Segment[]) => Promise<void>;
  onEditStateChange: (editing: boolean, saving?: boolean, dirty?: boolean) => void;
  onFollowOff: () => void;
  editButtonRef: RefObject<HTMLButtonElement | null>;
  toolbarCancelRef: RefObject<HTMLButtonElement | null>;
}) {
  const [draftSegments, setDraftSegments] = useState<Segment[] | null>(null);
  const [editingWord, setEditingWord] = useState<{ segment: number; word: number } | null>(null);
  const [wordDraft, setWordDraft] = useState("");
  const [wordError, setWordError] = useState<string | null>(null);
  const [savingWords, setSavingWords] = useState(false);
  const wordInputRef = useRef<HTMLInputElement>(null);
  const wordAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [wordFocusToken, setWordFocusToken] = useState(0);
  useEffect(() => {
    if (editingWord !== null) {
      wordInputRef.current?.focus();
      wordInputRef.current?.select();
    }
  }, [editingWord]);
  const editingWords = draftSegments !== null;
  const renderedSegments = draftSegments ?? segments;
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

  const beginWordEdit = useCallback(() => {
    setDraftSegments(
      segments.map((segment) => ({ ...segment, words: segment.words.map((word) => ({ ...word })) })),
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
        const corrected = replaceWordText(draftSegments, editingWord.segment, editingWord.word, wordDraft);
        setDraftSegments(corrected);
        setEditingWord(null);
        setWordError(null);
        onEditStateChange(true, savingWords, !sameWordTexts(originalWords, corrected.flatMap((segment) => segment.words)));
        if (restoreFocus) requestAnimationFrame(() => wordAnchorRef.current?.focus({ preventScroll: true }));
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
      onEditStateChange(true, savingWords, !sameWordTexts(originalWords, draftSegments.flatMap((segment) => segment.words)));
    }
    if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, [draftSegments, onEditStateChange, originalWords, savingWords]);

  const updateWordDraft = useCallback((text: string) => {
    setWordDraft(text);
    const target = editingWord
      ? renderedSegments[editingWord.segment]?.words[editingWord.word]?.text
      : undefined;
    onEditStateChange(true, savingWords, !sameWordTexts(originalWords, draftWords) || text !== target);
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

  return {
    editingWords, renderedSegments, editingWord, wordDraft, wordError, savingWords,
    wordInputRef, wordAnchorRef, wordFocusToken, hasWordChanges,
    beginWordEdit, applyWord, beginWord, cancelWordEdits, cancelWordInput,
    updateWordDraft, saveWordEdits,
  };
}
