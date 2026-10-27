import { Who } from "@desert-ant-labs/who";
import type { Turn } from "./merge";

export interface Diarization {
  speakerCount: number;
  turns: Turn[];
}

// The browser build of Who cannot run in a Worker here: its LiteRT loader uses
// importScripts, which the WebKit worker exposes but rejects for module workers.
// It runs on the UI thread instead, below the paint that shows the speaker step.
let loading: Promise<Awaited<ReturnType<typeof Who.load>>> | null = null;

export async function diarize(
  blob: Blob,
  onProgress?: (phase: string, fraction: number | null) => void,
): Promise<Diarization> {
  loading ??= Who.load({
    onProgress: (fraction) => onProgress?.("model", fraction),
  }).catch((error) => {
    loading = null;
    throw error;
  });
  const who = await Promise.race([
    loading,
    new Promise<never>((_, reject) =>
      globalThis.setTimeout(
        () => reject(new Error("Speaker model load timed out after 10 minutes.")),
        600_000,
      ),
    ),
  ]);
  onProgress?.("diarize", null);
  // Let the "Labeling speakers" state paint before the synchronous WASM pass.
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  const result = await who.diarize(blob);
  return {
    speakerCount: result.speakerCount,
    turns: result.turns.map((turn) => ({
      speaker: turn.speaker,
      start: turn.start,
      end: turn.end,
    })),
  };
}
