import { useCallback, useEffect, useRef, useState } from "react";
import { segmentIndexAt, wordIndexAt, type Segment } from "../../lib/transcript";
import type { TranscriptResult } from "../../lib/wire-types";

export interface Playback {
  audio: HTMLAudioElement;
  playing: boolean;
  duration: number;
  active: { segment: number; word: number };
  error: string | null;
  follow: boolean;
  canSeek: boolean;
  toggle: () => void;
  seek: (seconds: number) => void;
  preview: (seconds: number) => void;
  playFrom: (seconds: number) => void;
  retry: () => void;
  stopFollowing: () => void;
  followTranscript: () => void;
}

function mediaError(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return "The audio file could not be read.";
    case MediaError.MEDIA_ERR_DECODE:
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This audio could not be played here.";
    default:
      return "Playback stopped unexpectedly.";
  }
}

export const SEEK_EVENT = "ytt:seek";

function announceSeek(audio: HTMLAudioElement, at: number) {
  audio.dispatchEvent(new CustomEvent(SEEK_EVENT, { detail: at }));
}

export function usePlayback(result: TranscriptResult | null, segments: Segment[]): Playback {
  const [audio] = useState(() => new Audio());
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(result?.duration ?? 0);
  const [active, setActive] = useState({ segment: -1, word: -1 });
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  // sync() runs on every animation frame; a ref skips no-op state updates so
  // playback does not re-render the app between words.
  const activeRef = useRef(active);
  const pendingSeek = useRef<number | null>(null);
  const audioUrl = result?.audioUrl ?? "";

  const sync = useCallback(
    (at: number) => {
      const segment = segmentIndexAt(segments, at);
      const word = segment >= 0 ? wordIndexAt(segments[segment], at) : -1;
      const current = activeRef.current;
      if (current.segment === segment && current.word === word) return;
      activeRef.current = { segment, word };
      setActive(activeRef.current);
    },
    [segments],
  );

  useEffect(() => {
    if (!audioUrl) return;
    audio.preload = "metadata";
    audio.src = audioUrl;
    setError(null);
    setDuration(result?.duration ?? 0);
    activeRef.current = { segment: -1, word: -1 };
    setActive(activeRef.current);
    setFollow(true);
    audio.load();

    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setPlaying(false);
    };
  }, [audio, audioUrl]);

  useEffect(() => {
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => sync(audio.currentTime);
    const onEnded = () => setPlaying(false);
    const onMetadata = () => {
      setDuration(audio.duration || result?.duration || 0);
      if (pendingSeek.current !== null) {
        audio.currentTime = pendingSeek.current;
        pendingSeek.current = null;
      }
    };
    const onSeeked = () => sync(audio.currentTime);
    const onError = () => {
      if (!audio.getAttribute("src")) return;
      setError(mediaError(audio.error));
      setPlaying(false);
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("loadedmetadata", onMetadata);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("loadedmetadata", onMetadata);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("error", onError);
    };
  }, [audio, result?.duration, sync]);

  useEffect(() => {
    sync(audio.currentTime);
  }, [audio, sync]);

  useEffect(() => {
    if (!playing || segments.length === 0) return;
    let frame = 0;
    const tick = () => {
      sync(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audio, playing, segments.length, sync]);

  // The clock lives in PlayerBar. A seek started outside it (a transcript
  // timestamp) must move the clock before the media element reports the jump.
  const seek = useCallback(
    (seconds: number) => {
      const limit = audio.duration || result?.duration || seconds;
      const target = Math.max(0, Math.min(seconds, limit));
      if (audio.readyState === 0) {
        pendingSeek.current = target;
        sync(target);
        announceSeek(audio, target);
        return;
      }
      audio.currentTime = target;
      sync(target);
      announceSeek(audio, target);
    },
    [audio, result?.duration, sync],
  );

  const play = useCallback(() => {
    if (!audioUrl) return;
    void audio.play().catch(() => undefined);
  }, [audio, audioUrl]);

  const toggle = useCallback(() => {
    if (audio.paused) play();
    else audio.pause();
  }, [audio, play]);

  const playFrom = useCallback(
    (seconds: number) => {
      seek(seconds);
      play();
    },
    [play, seek],
  );

  const retry = useCallback(() => {
    setError(null);
    audio.load();
  }, [audio]);

  const stopFollowing = useCallback(() => setFollow(false), []);
  const followTranscript = useCallback(() => setFollow(true), []);

  return {
    audio,
    playing,
    duration,
    active,
    error,
    follow,
    canSeek: Boolean(audioUrl) && !error,
    toggle,
    seek,
    preview: sync,
    playFrom,
    retry,
    stopFollowing,
    followTranscript,
  };
}
