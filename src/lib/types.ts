import type { Word } from "./merge";

export type Stage = "metadata" | "download" | "convert" | "model" | "transcribe" | "done";

export interface ProgressEvent {
  jobId: string;
  stage: Stage;
  percent: number | null;
}

export interface TranscriptResult {
  jobId: string;
  title: string;
  duration: number | null;
  audioPath: string;
  audioUrl: string;
  waveform: number[];
  text: string;
  words: Word[];
}

export interface JobError {
  jobId: string;
  message: string;
}

export interface FileInfo {
  name: string;
  size: number;
}

export interface ToolsStatus {
  ytDlp: boolean;
  ytDlpVersion: string | null;
  ffmpeg: boolean;
  ffprobe: boolean;
  node: boolean;
  sidecar: boolean;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  version: string | null;
}
