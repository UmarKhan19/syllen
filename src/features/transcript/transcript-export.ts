import { invoke } from "@tauri-apps/api/core";
import { buildCues, slugify, toSrt, toTxt, toVtt } from "../../lib/captions";
import { mergeWords, type Segment, type SpeakerNames } from "../../lib/transcript";
import type { TranscriptResult } from "../../lib/wire-types";

export type ExportKind = "srt" | "vtt" | "txt";
export async function exportTranscript(
  result: TranscriptResult,
  segments: Segment[],
  names: SpeakerNames,
  kind: ExportKind,
): Promise<string | null> {
  const exportSegments = segments.length > 0 ? segments : mergeWords(result.words, []);
  const cues = buildCues(exportSegments);
  const contents =
    kind === "srt"
      ? toSrt(cues, names)
      : kind === "vtt"
        ? toVtt(cues, names)
        : toTxt(exportSegments, names);
  const name = `${slugify(result.title)}.${kind}`;
  return invoke<string | null>("export_text", { name, extension: kind, contents });
}
