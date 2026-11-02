import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mergeWords, type Segment } from "../../lib/transcript";
import type { JobError, ProgressEvent, TranscriptResult } from "../../lib/wire-types";

type Phase = "idle" | "running" | "who" | "done" | "error";

export function useJobPipeline(
  speakerLabelsRef: { current: boolean },
  refreshLibrary: () => void,
  setNotice: (notice: string) => void,
) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [whoProgress, setWhoProgress] = useState<{ phase: string; fraction: number | null } | null>(
    null,
  );
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [analysisReady, setAnalysisReady] = useState(true);
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  const [whoError, setWhoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const track = (promise: Promise<() => void>) => {
      promise.then((fn) => {
        if (disposed) fn();
        else unlisten.push(fn);
      });
    };
    let progressFrame = 0;
    let pendingProgress: ProgressEvent | null = null;
    const publishProgress = (next: ProgressEvent) => {
      pendingProgress = next;
      if (progressFrame) return;
      progressFrame = requestAnimationFrame(() => {
        progressFrame = 0;
        const value = pendingProgress;
        pendingProgress = null;
        if (!value) return;
        setProgress((current) =>
          current?.stage === value.stage && current.percent === value.percent ? current : value,
        );
      });
    };
    track(listen<ProgressEvent>("job:progress", (event) => publishProgress(event.payload)));
    track(
      listen<JobError>("job:error", (event) => {
        const message = event.payload.message;
        if (message === "Cancelled") {
          setPhase("idle");
          setProgress(null);
          return;
        }
        setError(message);
        setPhase("error");
      }),
    );
    track(
      listen<TranscriptResult>("job:result", async (event) => {
        const transcript = event.payload;
        setResult(transcript);
        setSegments([]);
        setAnalysisReady(false);
        setSpeakerCount(null);
        setWhoError(null);
        setWhoProgress(null);
        refreshLibrary();

        const saveSegments = async (next: Segment[], count: number | null): Promise<boolean> => {
          try {
            await invoke("save_analysis", {
              id: transcript.jobId,
              segments: next,
              speakerCount: count,
            });
            refreshLibrary();
            return true;
          } catch {
            setNotice("Speaker labels could not be saved to the library.");
            return false;
          }
        };

        if (!speakerLabelsRef.current) {
          const plain = mergeWords(transcript.words, []);
          setSegments(plain);
          setAnalysisReady(await saveSegments(plain, null));
          setPhase("done");
          return;
        }

        setPhase("who");
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        try {
          const { diarize, warm } = await import("./diarization-client");
          warm();
          const response = await fetch(convertFileSrc(transcript.audioPath));
          if (!response.ok)
            throw new Error(`The audio file could not be read (${response.status}).`);
          const audio = await response.arrayBuffer();
          const diarization = await diarize(audio, (name, fraction) =>
            setWhoProgress({ phase: name, fraction }),
          );
          const labelled = mergeWords(transcript.words, diarization.turns);
          setSegments(labelled);
          setSpeakerCount(diarization.speakerCount);
          setAnalysisReady(await saveSegments(labelled, diarization.speakerCount));
        } catch (problem) {
          const plain = mergeWords(transcript.words, []);
          setSegments(plain);
          setWhoError(problem instanceof Error ? problem.message : String(problem));
          setAnalysisReady(await saveSegments(plain, null));
        } finally {
          setPhase("done");
          setWhoProgress(null);
        }
      }),
    );
    return () => {
      disposed = true;
      cancelAnimationFrame(progressFrame);
      unlisten.forEach((fn) => fn());
    };
  }, []);

  async function start(source: { path: string } | { url: string }) {
    setError(null);
    setResult(null);
    setSegments([]);
    setAnalysisReady(true);
    setSpeakerCount(null);
    setWhoError(null);
    setWhoProgress(null);
    setProgress({ jobId: "", stage: "path" in source ? "convert" : "metadata", percent: null });
    setPhase("running");
    try {
      await invoke("start_job", source);
    } catch (problem) {
      setError(String(problem));
      setPhase("error");
    }
  }

  async function cancel() {
    try {
      await invoke("cancel_job");
    } catch (problem) {
      setError(String(problem));
      setPhase("error");
    }
  }

  function clearSession() {
    setResult(null);
    setSegments([]);
    setAnalysisReady(true);
    setSpeakerCount(null);
    setWhoError(null);
    setWhoProgress(null);
    setError(null);
    setPhase("idle");
  }

  function clearDeletedSession() {
    setResult(null);
    setSegments([]);
    setSpeakerCount(null);
    setPhase("idle");
  }

  function showSaved(transcript: TranscriptResult, nextSegments: Segment[], count: number | null) {
    setResult(transcript);
    setSegments(nextSegments);
    setAnalysisReady(true);
    setSpeakerCount(count);
    setWhoError(null);
    setWhoProgress(null);
    setError(null);
    setPhase("done");
  }

  return {
    phase,
    setPhase,
    progress,
    result,
    setResult,
    segments,
    setSegments,
    analysisReady,
    setAnalysisReady,
    speakerCount,
    setSpeakerCount,
    whoProgress,
    setWhoProgress,
    whoError,
    setWhoError,
    error,
    setError,
    start,
    cancel,
    clearSession,
    clearDeletedSession,
    showSaved,
  };
}
