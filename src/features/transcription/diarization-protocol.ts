import type { Turn } from "../../lib/transcript";

export type WhoPhase = "model" | "diarize";

export type WhoRequest = { id: number; audio: ArrayBuffer };

export type WhoMessage =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "progress"; id: number; phase: WhoPhase; fraction: number | null }
  | { type: "result"; id: number; speakerCount: number; turns: Turn[] }
  | { type: "error"; id: number; message: string };
