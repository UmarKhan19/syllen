import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  formatClock,
  segmentIndexAt,
  wordIndexAt,
  type Segment,
} from "./lib/merge";
import type { TranscriptResult } from "./lib/types";

const WAVE_HEIGHT = 28;
const WAVE_PITCH = 3;
const WAVE_BAR = 2;

export interface Playback {
  audio: HTMLAudioElement;
  playing: boolean;
  time: number;
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

export function usePlayback(
  result: TranscriptResult | null,
  segments: Segment[],
): Playback {
  const [audio] = useState(() => new Audio());
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(result?.duration ?? 0);
  const [active, setActive] = useState({ segment: -1, word: -1 });
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const pendingSeek = useRef<number | null>(null);
  const audioUrl = result?.audioUrl ?? "";

  const sync = useCallback(
    (at: number) => {
      const segment = segmentIndexAt(segments, at);
      const word = segment >= 0 ? wordIndexAt(segments[segment], at) : -1;
      setActive((current) =>
        current.segment === segment && current.word === word
          ? current
          : { segment, word },
      );
    },
    [segments],
  );

  useEffect(() => {
    if (!audioUrl) return;
    audio.preload = "metadata";
    audio.src = audioUrl;
    setError(null);
    setTime(0);
    setDuration(result?.duration ?? 0);
    setActive({ segment: -1, word: -1 });
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
    const onTime = () => {
      setTime(audio.currentTime);
      sync(audio.currentTime);
    };
    const onEnded = () => {
      setPlaying(false);
      setTime(audio.duration || 0);
    };
    const onMetadata = () => {
      setDuration(audio.duration || result?.duration || 0);
      if (pendingSeek.current !== null) {
        audio.currentTime = pendingSeek.current;
        setTime(pendingSeek.current);
        pendingSeek.current = null;
      }
    };
    const onSeeked = () => {
      setTime(audio.currentTime);
      sync(audio.currentTime);
    };
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

  const seek = useCallback(
    (seconds: number) => {
      const limit = audio.duration || result?.duration || seconds;
      const target = Math.max(0, Math.min(seconds, limit));
      if (audio.readyState === 0) {
        pendingSeek.current = target;
        setTime(target);
        sync(target);
        return;
      }
      audio.currentTime = target;
      setTime(target);
      sync(target);
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
    time,
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

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function paintWave(
  canvas: HTMLCanvasElement,
  peaks: number[],
  width: number,
  duration: number,
  at: number,
  hover: number | null,
  colors: { played: string; rest: string },
) {
  if (width <= 0) return;
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(WAVE_HEIGHT * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, WAVE_HEIGHT);

  const progress =
    duration > 0 ? clamp(at / duration, 0, 1) * width : 0;

  if (peaks.length === 0) {
    context.fillStyle = colors.rest;
    context.fillRect(0, WAVE_HEIGHT / 2 - 1, width, 2);
    context.fillStyle = colors.played;
    context.fillRect(0, WAVE_HEIGHT / 2 - 1, progress, 2);
  } else {
    const bars = Math.max(1, Math.floor(width / WAVE_PITCH));
    for (let index = 0; index < bars; index += 1) {
      const from = Math.floor((index * peaks.length) / bars);
      const to = Math.max(
        from + 1,
        Math.floor(((index + 1) * peaks.length) / bars),
      );
      let peak = 0;
      for (let sample = from; sample < to; sample += 1) {
        peak = Math.max(peak, peaks[sample] ?? 0);
      }
      const height = Math.max(
        2,
        Math.round(Math.pow(peak / 255, 0.72) * (WAVE_HEIGHT - 4)),
      );
      const x = index * WAVE_PITCH;
      context.fillStyle =
        x + WAVE_BAR > progress ? colors.rest : colors.played;
      context.fillRect(x, (WAVE_HEIGHT - height) / 2, WAVE_BAR, height);
    }
  }

  if (hover !== null && duration > 0) {
    const x = Math.round(clamp(hover / duration, 0, 1) * width);
    context.globalAlpha = 0.4;
    context.fillStyle = colors.played;
    context.fillRect(Math.min(x, width - 1), 0, 1, WAVE_HEIGHT);
    context.globalAlpha = 1;
  }
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.6 3.4v9.2L12.4 8 5.6 3.4Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4.7" y="3.5" width="2.3" height="9" rx="0.6" fill="currentColor" />
      <rect x="9" y="3.5" width="2.3" height="9" rx="0.6" fill="currentColor" />
    </svg>
  );
}

function FollowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 2.6v3.1M12 18.3v3.1M2.6 12h3.1M18.3 12h3.1" />
    </svg>
  );
}

export function PlayerBar({
  playback,
  peaks,
  canFollow,
}: {
  playback: Playback;
  peaks: number[];
  canFollow: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [pointerFocus, setPointerFocus] = useState(false);
  const scrubValue = useRef<number | null>(null);
  const resume = useRef(false);
  const { audio, playing, time, duration, error } = playback;

  const colors = useMemo(() => {
    const styles = getComputedStyle(document.documentElement);
    return {
      played: styles.getPropertyValue("--ink").trim() || "#14161a",
      rest: styles.getPropertyValue("--wave").trim() || "#c9c6bf",
    };
  }, []);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const shown = scrub ?? time;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const pointer = scrub ?? hover;
    const paint = () => {
      paintWave(canvas, peaks, width, duration, shown, pointer, colors);
    };
    paint();
    if (!playing || scrub !== null) return;
    const loop = () => {
      paintWave(canvas, peaks, width, duration, audio.currentTime, pointer, colors);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [audio, colors, duration, hover, peaks, playing, scrub, shown, width]);

  const timeAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return fraction * duration;
  };

  const beginScrub = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!playback.canSeek || duration <= 0) return;
    event.preventDefault();
    setPointerFocus(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    resume.current = !audio.paused;
    audio.pause();
    scrubValue.current = timeAt(event);
    setScrub(scrubValue.current);
    setHover(scrubValue.current);
    playback.preview(scrubValue.current);
  };

  const moveScrub = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!playback.canSeek || duration <= 0) return;
    const value = timeAt(event);
    setHover(value);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    scrubValue.current = value;
    setScrub(value);
    playback.preview(value);
  };

  const endScrub = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const value = scrubValue.current;
    scrubValue.current = null;
    setScrub(null);
    if (value === null) return;
    playback.seek(value);
    if (resume.current) playback.audio.play().catch(() => undefined);
    resume.current = false;
  };

  const onCanvasKey = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (!playback.canSeek || duration <= 0) return;
    const step = event.shiftKey ? 15 : 5;
    let target: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      target = Math.max(0, time - step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      target = Math.min(duration, time + step);
    } else if (event.key === "PageDown") {
      target = Math.min(duration, time + 30);
    } else if (event.key === "PageUp") {
      target = Math.max(0, time - 30);
    } else if (event.key === "Home") {
      target = 0;
    } else if (event.key === "End") {
      target = duration;
    }
    if (target === null) return;
    event.preventDefault();
    playback.seek(target);
  };

  const tip = (scrub ?? hover) !== null && duration > 0 ? (scrub ?? hover) : null;
  const tipLeft =
    tip !== null && width > 0
      ? clamp((tip / duration) * width, 26, Math.max(26, width - 26))
      : 0;

  return (
    <section className="player" aria-label="Audio player">
      <button
        type="button"
        className="playButton"
        onClick={playback.toggle}
        disabled={Boolean(error) || !playback.canSeek}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      {error ? (
        <p className="playerError" role="status" title={error}>
          Playback unavailable
          <button type="button" className="playerRetry" onClick={playback.retry}>
            Retry
          </button>
        </p>
      ) : (
        <span className="clock" aria-hidden="true">
          <span className="clockNow">{formatClock(shown)}</span>
          <span className="clockSep">/</span>
          <span className="clockTotal">{formatClock(duration)}</span>
        </span>
      )}

      <div className="wave" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={`waveCanvas${pointerFocus ? " pointer" : ""}`}
          style={{ height: WAVE_HEIGHT }}
          role="slider"
          tabIndex={0}
          aria-label="Seek audio"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(duration))}
          aria-valuenow={Math.max(0, Math.round(shown))}
          aria-valuetext={formatClock(shown)}
          aria-disabled={playback.canSeek ? undefined : true}
          onBlur={() => setPointerFocus(false)}
          onPointerDown={beginScrub}
          onPointerMove={moveScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onCanvasKey}
        />
        {tip !== null && (
          <span className="waveTip" style={{ left: tipLeft }}>
            {formatClock(tip)}
          </span>
        )}
      </div>

      {canFollow && (
        <button
          type="button"
          className={`followButton${playback.follow ? " on" : ""}`}
          onClick={
            playback.follow ? playback.stopFollowing : playback.followTranscript
          }
          aria-pressed={playback.follow}
          title={
            playback.follow
              ? "Stop following the transcript"
              : "Scroll to the current passage"
          }
        >
          <FollowIcon />
          <span>{playback.follow ? "Following" : "Follow"}</span>
        </button>
      )}
    </section>
  );
}
