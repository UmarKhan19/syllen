import { invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
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
  let defaultPath = name;
  try {
    defaultPath = await join(await downloadDir(), name);
  } catch {
    /* use the dialog's default location */
  }
  const path = await save({
    defaultPath,
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
  });
  if (!path) return null;
  await invoke("save_text", { path, contents });
  return path.split(/[\\/]/).pop() ?? path;
}
