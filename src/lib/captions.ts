import { joinWords, speakerLabel, type Segment, type SpeakerNames, type Word } from "./transcript";

export interface Cue {
  speaker: number | null;
  start: number;
  end: number;
  text: string;
}

export function buildCues(segments: Segment[], maxChars = 84, maxDuration = 7): Cue[] {
  const cues: Cue[] = [];
  for (const segment of segments) {
    let words: Word[] = [];
    const flush = () => {
      if (!words.length) return;
      cues.push({
        speaker: segment.speaker,
        start: words[0].start,
        end: words[words.length - 1].end,
        text: joinWords(words),
      });
      words = [];
    };
    for (const word of segment.words) {
      if (words.length) {
        const gap = word.start - words[words.length - 1].end;
        const duration = word.end - words[0].start;
        const length = joinWords([...words, word]).length;
        if (length > maxChars || duration > maxDuration || gap > 1.2) flush();
      }
      words.push(word);
      if (/[.!?]$/.test(word.text) && joinWords(words).length > 32) flush();
    }
    flush();
  }
  return cues;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatTimestamp(seconds: number, separator: "," | "." = "."): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function toSrt(cues: Cue[], speakerNames: SpeakerNames = {}): string {
  return cues
    .map((cue, index) => {
      const time = `${formatTimestamp(cue.start, ",")} --> ${formatTimestamp(cue.end, ",")}`;
      const prefix = cue.speaker === null ? "" : `[${speakerLabel(cue.speaker, speakerNames)}] `;
      return `${index + 1}\n${time}\n${prefix}${cue.text}\n`;
    })
    .join("\n");
}

export function toVtt(cues: Cue[], speakerNames: SpeakerNames = {}): string {
  const body = cues
    .map((cue) => {
      const voice =
        cue.speaker === null
          ? null
          : speakerLabel(cue.speaker, speakerNames)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
      const line = voice === null ? cue.text : `<v ${voice}>${cue.text}`;
      return `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${line}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function toTxt(segments: Segment[], speakerNames: SpeakerNames = {}): string {
  return segments
    .map((segment) => {
      const prefix =
        segment.speaker === null ? "" : `${speakerLabel(segment.speaker, speakerNames)}: `;
      return `[${formatClock(segment.start)}] ${prefix}${segment.text}`;
    })
    .join("\n\n");
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "transcript";
}
