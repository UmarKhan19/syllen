import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { joinWords, type Segment, type Word } from "../../lib/transcript";
import type { TranscriptResult } from "../../lib/wire-types";

export function useTranscriptSession(
  result: TranscriptResult | null,
  setResult: Dispatch<SetStateAction<TranscriptResult | null>>,
  setSegments: Dispatch<SetStateAction<Segment[]>>,
  refreshLibrary: () => void,
  setNotice: (notice: string) => void,
) {
  const [speakerNames, setSpeakerNames] = useState<Record<number, string>>({});
  const speakerNamesRef = useRef<Record<number, string>>({});

  const clearNames = useCallback(() => {
    speakerNamesRef.current = {};
    setSpeakerNames({});
  }, []);
  const restoreNames = useCallback((names: Record<number, string>) => {
    speakerNamesRef.current = names;
    setSpeakerNames(names);
  }, []);
  const renameSpeaker = useCallback(
    (speaker: number, name: string) => {
      const next = { ...speakerNamesRef.current, [speaker]: name };
      speakerNamesRef.current = next;
      setSpeakerNames(next);
      if (result)
        invoke("save_speaker_names", {
          id: result.jobId,
          names: Object.fromEntries(Object.entries(next)),
        }).catch(() => setNotice("The speaker name could not be saved."));
    },
    [result, setNotice],
  );
  const saveWordCorrections = useCallback(
    async (expectedWords: Word[], words: Word[], nextSegments: Segment[]) => {
      if (!result?.saved) throw new Error("This transcript is not saved to the library.");
      await invoke("save_word_corrections", { id: result.jobId, expectedWords, words });
      setSegments(nextSegments);
      setResult((current) =>
        current?.jobId === result.jobId ? { ...current, words, text: joinWords(words) } : current,
      );
      refreshLibrary();
      setNotice("Word corrections saved");
    },
    [refreshLibrary, result, setNotice, setResult, setSegments],
  );

  return {
    speakerNames,
    speakerNamesRef,
    clearNames,
    restoreNames,
    renameSpeaker,
    saveWordCorrections,
  };
}
