import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeWords, type Segment } from "../../lib/transcript";
import type {
  JobError,
  JobResult,
  ProgressEvent,
  ThermalEvent,
  ThermalStatus,
  TranscriptResult,
} from "../../lib/wire-types";
import type { ResourcePreset } from "../settings/resource-preset";
import {
  unavailableThermalStatus,
  validateThermalStatus,
  waitForThermalCooldown,
} from "../settings/thermal-guard";
import { abortDiarization, diarize, ThermalGuardError, warm } from "./diarization-client";

type Phase = "idle" | "running" | "who" | "done" | "error";
type JobStarted = { job_id: string };
type Attempt = { controller: AbortController; generation: number; thermalError: Error | null };

export function matchesActiveJobId(activeJobId: string | null, eventJobId: string) {
  return activeJobId !== null && activeJobId === eventJobId;
}

export function retainJobForWhoRetry<T extends { generation: number }>(
  job: T | null,
  generation: number,
): T | null {
  return job ? { ...job, generation } : null;
}

export function startJob(
  source: { path: string } | { url: string },
  resourcePreset: ResourcePreset,
  thermalGuardEnabled = true,
) {
  return invoke<JobStarted>("start_job", { ...source, resourcePreset, thermalGuardEnabled });
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

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
  const [thermalStatus, setThermalStatus] = useState<ThermalStatus | null>(null);
  const [thermalState, setThermalState] = useState<ThermalEvent["state"]>("monitoring");
  const current = useRef<{
    id: string | null;
    generation: number;
    enabled: boolean;
    label: boolean;
  } | null>(null);
  const generation = useRef(0);
  const attempt = useRef<Attempt | null>(null);
  const pendingResults = useRef(new Map<string, JobResult>());
  const pendingThermal = useRef(new Map<string, ThermalEvent>());
  const retryTranscript = useRef<JobResult | null>(null);

  const abortAttempt = useCallback(
    (reason: Error | DOMException = new DOMException("Cancelled", "AbortError")) => {
      const active = attempt.current;
      if (!active) return;
      active.controller.abort(reason);
      abortDiarization(reason);
      attempt.current = null;
    },
    [],
  );

  const saveSegments = useCallback(
    async (transcript: TranscriptResult, next: Segment[], count: number | null) => {
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
    },
    [refreshLibrary, setNotice],
  );

  const runWho = useCallback(
    async (transcript: JobResult, jobGeneration: number) => {
      if (attempt.current) return;
      const mine: Attempt = {
        controller: new AbortController(),
        generation: jobGeneration,
        thermalError: null,
      };
      attempt.current = mine;
      setPhase("who");
      setWhoProgress(null);
      setWhoError(null);
      const isCurrent = () =>
        attempt.current === mine &&
        current.current?.generation === jobGeneration &&
        generation.current === jobGeneration;
      const readStatus = async () => {
        let timer = 0;
        try {
          const status = await Promise.race([
            invoke<ThermalStatus>("thermal_status"),
            new Promise<never>((_, reject) => {
              timer = window.setTimeout(
                () => reject(new Error("Temperature check timed out.")),
                2500,
              );
            }),
          ]);
          const validated = validateThermalStatus(status);
          if (isCurrent()) {
            setThermalStatus(validated);
            if (transcript.thermalGuardEnabled && !validated.available)
              setThermalState("unavailable");
          }
          return validated;
        } catch (problem) {
          const unavailable = unavailableThermalStatus(String(problem));
          if (isCurrent()) {
            setThermalStatus(unavailable);
            setThermalState("unavailable");
          }
          return unavailable;
        } finally {
          window.clearTimeout(timer);
        }
      };
      const waitSleep = (ms: number, signal: AbortSignal) => delay(ms, signal);
      const plain = mergeWords(transcript.words, []);
      setSegments(plain);
      setAnalysisReady(true);
      setSpeakerCount(null);
      retryTranscript.current = transcript;
      try {
        if (transcript.thermalGuardEnabled) {
          const initial = await readStatus();
          if (!isCurrent()) return;
          setThermalStatus(initial);
          if (!initial.available) {
            setThermalState("unavailable");
            setWhoError(
              `Thermal protection unavailable: ${initial.reason ?? "CPU temperature could not be read."} Continuing without automatic protection.`,
            );
          } else if (
            initial.temperatureC !== null &&
            initial.pauseAtC !== null &&
            initial.temperatureC >= initial.pauseAtC
          ) {
            setThermalState("cooling");
            const cool = await waitForThermalCooldown(
              readStatus,
              mine.controller.signal,
              waitSleep,
              Date.now,
            );
            if (!isCurrent()) return;
            setThermalStatus(cool);
            setThermalState(cool.available ? "monitoring" : "unavailable");
            if (!cool.available)
              setWhoError(
                `Thermal protection unavailable: ${cool.reason ?? "CPU temperature could not be read."} Continuing without automatic protection.`,
              );
          }
        }

        const monitor = async () => {
          while (isCurrent() && !mine.controller.signal.aborted && transcript.thermalGuardEnabled) {
            const status = await readStatus();
            if (!isCurrent() || mine.controller.signal.aborted) return;
            setThermalStatus(status);
            if (!status.available) {
              setThermalState("unavailable");
              setWhoError(
                `Thermal protection unavailable: ${status.reason ?? "CPU temperature could not be read."} Continuing without automatic protection.`,
              );
            } else if (
              status.temperatureC !== null &&
              status.pauseAtC !== null &&
              status.temperatureC >= status.pauseAtC
            ) {
              if (!isCurrent()) return;
              const problem = new ThermalGuardError();
              mine.thermalError = problem;
              mine.controller.abort(problem);
              abortDiarization(problem);
              throw problem;
            } else {
              setThermalState("monitoring");
            }
            await delay(1000, mine.controller.signal);
          }
        };

        const work = async () => {
          if (!isCurrent() || mine.controller.signal.aborted) return null;
          if (!transcript.thermalGuardEnabled) warm(transcript.cpuThreads);
          const response = await fetch(convertFileSrc(transcript.audioPath), {
            signal: mine.controller.signal,
          });
          if (!isCurrent() || mine.controller.signal.aborted) return null;
          if (!response.ok)
            throw new Error(`The audio file could not be read (${response.status}).`);
          const audio = await response.arrayBuffer();
          if (!isCurrent() || mine.controller.signal.aborted) return null;
          const diarization = await diarize(audio, transcript.cpuThreads, (name, fraction) => {
            if (isCurrent()) setWhoProgress({ phase: name, fraction });
          });
          return diarization;
        };

        const workPromise = work();
        const diarization = transcript.thermalGuardEnabled
          ? await Promise.race([workPromise, monitor()])
          : await workPromise;
        if (!diarization || !isCurrent()) return;
        const labelled = mergeWords(transcript.words, diarization.turns);
        setSegments(labelled);
        setSpeakerCount(diarization.speakerCount);
        const saved = await saveSegments(transcript, labelled, diarization.speakerCount);
        if (isCurrent()) setAnalysisReady(saved);
        retryTranscript.current = null;
      } catch (problem) {
        if (!isCurrent()) return;
        if (mine.thermalError) {
          setWhoError(mine.thermalError.message);
          const saved = await saveSegments(transcript, plain, null);
          if (isCurrent()) setAnalysisReady(saved);
        } else if (!mine.controller.signal.aborted) {
          setWhoError(problem instanceof Error ? problem.message : String(problem));
          const saved = await saveSegments(transcript, plain, null);
          if (isCurrent()) setAnalysisReady(saved);
        }
      } finally {
        if (attempt.current === mine) {
          attempt.current = null;
          setPhase("done");
          setWhoProgress(null);
          if (mine.thermalError) retryTranscript.current = transcript;
        }
      }
    },
    [saveSegments],
  );

  const processResult = useCallback(
    async (transcript: JobResult, jobGeneration: number) => {
      if (generation.current !== jobGeneration || current.current?.id !== transcript.jobId) return;
      setResult(transcript);
      setSegments(mergeWords(transcript.words, []));
      setAnalysisReady(true);
      setSpeakerCount(null);
      setWhoError(null);
      setWhoProgress(null);
      retryTranscript.current = transcript;
      refreshLibrary();
      const active = current.current;
      if (!active?.label) {
        const plain = mergeWords(transcript.words, []);
        setSegments(plain);
        const saved = await saveSegments(transcript, plain, null);
        if (generation.current === jobGeneration) {
          setAnalysisReady(saved);
          setPhase("done");
        }
        retryTranscript.current = null;
        return;
      }
      await runWho(transcript, jobGeneration);
    },
    [refreshLibrary, runWho, saveSegments],
  );

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
      if (!matchesActiveJobId(current.current?.id ?? null, next.jobId)) return;
      pendingProgress = next;
      if (progressFrame) return;
      progressFrame = requestAnimationFrame(() => {
        progressFrame = 0;
        const value = pendingProgress;
        pendingProgress = null;
        if (value)
          setProgress((old) =>
            old?.stage === value.stage && old.percent === value.percent ? old : value,
          );
      });
    };
    track(listen<ProgressEvent>("job:progress", (event) => publishProgress(event.payload)));
    track(
      listen<JobError>("job:error", (event) => {
        if (!matchesActiveJobId(current.current?.id ?? null, event.payload.jobId)) return;
        if (event.payload.message === "Cancelled") {
          abortAttempt();
          setPhase("idle");
          setProgress(null);
          return;
        }
        abortAttempt();
        setError(event.payload.message);
        setPhase("error");
      }),
    );
    track(
      listen<JobResult>("job:result", (event) => {
        const value = event.payload;
        if (!current.current || current.current.id === null) {
          pendingResults.current.set(value.jobId, value);
          return;
        }
        if (current.current.id === value.jobId)
          void processResult(value, current.current.generation);
      }),
    );
    track(
      listen<ThermalEvent>("job:thermal", (event) => {
        const value = event.payload;
        if (!current.current || current.current.id === null) {
          pendingThermal.current.set(value.jobId, value);
          return;
        }
        if (!matchesActiveJobId(current.current?.id ?? null, value.jobId)) return;
        setThermalStatus(value.status);
        setThermalState(value.state);
      }),
    );
    return () => {
      disposed = true;
      cancelAnimationFrame(progressFrame);
      abortAttempt();
      for (const fn of unlisten) fn();
    };
  }, [abortAttempt, processResult]);

  async function start(
    source: { path: string } | { url: string },
    resourcePreset: ResourcePreset,
    thermalGuardEnabled: boolean,
  ) {
    abortAttempt();
    const jobGeneration = ++generation.current;
    current.current = {
      id: null,
      generation: jobGeneration,
      enabled: thermalGuardEnabled,
      label: speakerLabelsRef.current,
    };
    retryTranscript.current = null;
    pendingResults.current.clear();
    pendingThermal.current.clear();
    setError(null);
    setResult(null);
    setSegments([]);
    setAnalysisReady(true);
    setSpeakerCount(null);
    setWhoError(null);
    setWhoProgress(null);
    setThermalState("monitoring");
    setProgress({ jobId: "", stage: "path" in source ? "convert" : "metadata", percent: null });
    setPhase("running");
    try {
      const started = await startJob(source, resourcePreset, thermalGuardEnabled);
      if (generation.current !== jobGeneration) return;
      current.current.id = started.job_id;
      const earlyThermal = pendingThermal.current.get(started.job_id);
      pendingThermal.current.clear();
      if (earlyThermal) {
        setThermalStatus(earlyThermal.status);
        setThermalState(earlyThermal.state);
      }
      const early = pendingResults.current.get(started.job_id);
      pendingResults.current.clear();
      if (early) void processResult(early, jobGeneration);
    } catch (problem) {
      if (generation.current !== jobGeneration) return;
      setError(String(problem));
      setPhase("error");
    }
  }

  async function cancel() {
    if (phase === "who") {
      const nextGeneration = ++generation.current;
      current.current = retainJobForWhoRetry(current.current, nextGeneration);
      abortAttempt();
      setWhoError("Speaker analysis cancelled.");
      setWhoProgress(null);
      setPhase("done");
      return;
    }
    ++generation.current;
    current.current = null;
    retryTranscript.current = null;
    abortAttempt();
    try {
      await invoke("cancel_job");
    } catch (problem) {
      setError(String(problem));
      setPhase("error");
    }
  }

  const retryWho = useCallback(() => {
    const transcript = retryTranscript.current;
    const active = current.current;
    if (transcript && active && transcript.jobId === active.id)
      void runWho(transcript, active.generation);
  }, [runWho]);

  function clearSession() {
    ++generation.current;
    current.current = null;
    retryTranscript.current = null;
    abortAttempt();
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
    clearSession();
  }

  function showSaved(transcript: TranscriptResult, nextSegments: Segment[], count: number | null) {
    ++generation.current;
    current.current = null;
    retryTranscript.current = null;
    abortAttempt();
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
    thermalStatus,
    thermalState,
    retryWho,
    start,
    cancel,
    clearSession,
    clearDeletedSession,
    showSaved,
  };
}
