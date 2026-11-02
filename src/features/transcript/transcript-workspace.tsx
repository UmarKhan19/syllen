import { useState, type RefObject } from "react";
import type { Playback } from "../playback/use-playback";
import type { Segment, Word } from "../../lib/transcript";
import type { TranscriptResult } from "../../lib/wire-types";
import { formatClock } from "../../lib/captions";
import { PlayerBar } from "../playback/player-bar";
import { Transcript } from "./transcript";
import { AlertIcon } from "../../icons";

export function TranscriptWorkspace({
  result,
  segments,
  speakerCount,
  whoError,
  speakerNames,
  wordEditing,
  canEditWords,
  playback,
  onCopy,
  onExport,
  onRename,
  onSaveWords,
  onEditStateChange,
  editButtonRef,
  toolbarCancelRef,
  toolbarSaveRef,
  titleRef,
}: {
  result: TranscriptResult;
  segments: Segment[];
  speakerCount: number | null;
  whoError: string | null;
  speakerNames: Record<number, string>;
  wordEditing: boolean;
  canEditWords: boolean;
  playback: Playback;
  onCopy: () => void;
  onExport: (kind: "srt" | "vtt" | "txt") => void;
  onRename: (speaker: number, name: string) => void;
  onSaveWords: (expected: Word[], words: Word[], segments: Segment[]) => Promise<void>;
  onEditStateChange: (editing: boolean, saving?: boolean, dirty?: boolean) => void;
  editButtonRef: RefObject<HTMLButtonElement | null>;
  toolbarCancelRef: RefObject<HTMLButtonElement | null>;
  toolbarSaveRef: RefObject<HTMLButtonElement | null>;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [errorHost, setErrorHost] = useState<HTMLDivElement | null>(null);
  const TOOLBAR =
    "h-8.5 cursor-pointer border-0 bg-transparent px-3.5 py-0 text-small text-ink-2 transition-colors duration-150 ease-[ease] hover:bg-wash hover:text-ink disabled:cursor-not-allowed disabled:opacity-45";
  return (
    <article className="mt-10">
      <div className="flex flex-wrap items-start justify-between gap-6 border-b border-rule pb-5">
        <div>
          <h2 ref={titleRef} tabIndex={-1} className="m-0 max-w-[26ch] text-title font-semibold">
            {result.title}
          </h2>
          <p className="mt-2.25 mb-0 text-meta text-ink-3 tabular-nums">
            {formatClock(result.duration ?? 0)}
            {speakerCount !== null && speakerCount > 0 && (
              <>
                <span className="mx-2.25 text-rule">·</span>
                {speakerCount === 1 ? "1 speaker" : `${speakerCount} speakers`}
              </>
            )}
            <span className="mx-2.25 text-rule">·</span>
            {result.words.length} words<span className="mx-2.25 text-rule">·</span>
            <span
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
              title={
                result.saved
                  ? "Transcript and audio are stored on this machine"
                  : "This transcript could not be saved to the library"
              }
            >
              <span
                className={`size-1.25 shrink-0 rounded-full ${result.saved ? "bg-ok" : "bg-ink-3"}`}
              />
              {result.saved ? "Saved locally" : "Not saved"}
            </span>
          </p>
        </div>
      </div>
      {whoError && (
        <div className="mt-4.5 flex gap-2.75 rounded-card border border-rule bg-sheet px-4 py-3.25 text-small leading-[1.6] text-ink-2 [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg]:basis-4 [&_svg]:text-ink-3 [&_strong]:font-semibold [&_strong]:text-ink">
          <AlertIcon />
          <span>
            <strong>Speaker labels unavailable.</strong> {whoError}
          </span>
        </div>
      )}
      <div className="sticky top-bar z-[15] mt-1 bg-paper" data-reading-dock>
        <div className="grid min-h-9.5 grid-cols-[minmax(0,1fr)] items-center border-b border-rule">
          <div
            className="inline-flex flex-none justify-self-end rounded-control border border-rule bg-sheet"
            role="toolbar"
            aria-label="Transcript actions"
          >
            {!wordEditing && (
              <>
                <button type="button" className={`${TOOLBAR} rounded-l-[8px]`} onClick={onCopy}>
                  Copy
                </button>
                <button
                  type="button"
                  className={`${TOOLBAR} border-l border-rule`}
                  onClick={() => onExport("srt")}
                >
                  SRT
                </button>
                <button
                  type="button"
                  className={`${TOOLBAR} border-l border-rule`}
                  onClick={() => onExport("vtt")}
                >
                  VTT
                </button>
                <button
                  type="button"
                  className={`${TOOLBAR} border-l border-rule${canEditWords ? "" : " rounded-r-[8px]"}`}
                  onClick={() => onExport("txt")}
                >
                  TXT
                </button>
              </>
            )}
            {canEditWords && (
              <div
                ref={setActionHost}
                className={`flex min-h-9 flex-none items-center gap-2 ${wordEditing ? "" : "border-l border-rule pl-2 [&>button]:rounded-r-[8px]"}`}
              />
            )}
          </div>
          <div ref={setErrorHost} className="min-w-0 pt-1 pb-2 empty:hidden" />
        </div>
        {result.audioUrl && (
          <PlayerBar
            playback={playback}
            peaks={result.waveform ?? []}
            canFollow={segments.length > 0}
          />
        )}
      </div>
      <Transcript
        segments={segments}
        fallback={result.text}
        speakerNames={speakerNames}
        onRename={onRename}
        canEditWords={canEditWords}
        onSaveWords={onSaveWords}
        onEditStateChange={onEditStateChange}
        actionHost={actionHost}
        errorHost={errorHost}
        editButtonRef={editButtonRef}
        toolbarCancelRef={toolbarCancelRef}
        toolbarSaveRef={toolbarSaveRef}
        active={playback.active}
        onSeek={playback.canSeek ? playback.playFrom : undefined}
        follow={playback.follow}
        onFollowOff={playback.stopFollowing}
      />
    </article>
  );
}
