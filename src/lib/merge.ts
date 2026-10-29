export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Turn {
  speaker: number;
  start: number;
  end: number;
}

export interface Segment {
  speaker: number | null;
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface Cue {
  speaker: number | null;
  start: number;
  end: number;
  text: string;
}

export type SpeakerNames = Partial<Record<number, string>>;

export const speakerLabel = (
  speaker: number | null,
  speakerNames: SpeakerNames = {},
) =>
  speaker === null
    ? "Unknown speaker"
    : speakerNames[speaker]?.trim() || `Speaker ${speaker + 1}`;

const PUNCTUATION_ONLY = /^[.,!?;:…)»"']+$/;

export function joinWords(words: Word[]): string {
  return words.reduce((text, word) => {
    if (!text) return word.text;
    if (PUNCTUATION_ONLY.test(word.text)) return text + word.text;
    return `${text} ${word.text}`;
  }, "");
}

function overlapSeconds(a: Word, b: Turn): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function gapSeconds(a: Word, b: Turn): number {
  if (a.end < b.start) return b.start - a.end;
  if (a.start > b.end) return a.start - b.end;
  return 0;
}

export function speakerAt(word: Word, turns: Turn[]): number | null {
  let best: number | null = null;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap = overlapSeconds(word, turn);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = turn.speaker;
    }
  }
  if (best !== null) return best;

  let nearest: number | null = null;
  let nearestGap = Infinity;
  for (const turn of turns) {
    const gap = gapSeconds(word, turn);
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = turn.speaker;
    }
  }
  return nearestGap <= 1.5 ? nearest : null;
}

const SENTENCE_END = /[.!?]["'”’)\]]*$/;

// Break at a sentence end once a paragraph is comfortable to read, so the
// timestamps land on natural pauses instead of a fixed interval. The hard
// caps stop unpunctuated speech from turning into one long block.
function paragraphBreak(segment: Segment, gap: number): boolean {
  const span = segment.end - segment.start;
  if (span >= 60 || segment.text.length >= 800) return true;
  const last = segment.words[segment.words.length - 1];
  return (
    SENTENCE_END.test(last.text) &&
    (gap >= 1 || span >= 25 || segment.text.length >= 300)
  );
}

export function mergeWords(words: Word[], turns: Turn[], maxGap = 2): Segment[] {
  const segments: Segment[] = [];
  for (const word of words) {
    const speaker = speakerAt(word, turns);
    const last = segments[segments.length - 1];
    const gap = last ? word.start - last.end : 0;
    if (
      last &&
      last.speaker === speaker &&
      gap <= maxGap &&
      !paragraphBreak(last, gap)
    ) {
      last.words.push(word);
      last.end = word.end;
      last.text = joinWords(last.words);
    } else {
      segments.push({
        speaker,
        start: word.start,
        end: word.end,
        text: word.text,
        words: [word],
      });
    }
  }
  return segments;
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
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

export function toSrt(cues: Cue[], speakerNames: SpeakerNames = {}): string {
  return cues
    .map((cue, index) => {
      const time = `${formatTimestamp(cue.start, ",")} --> ${formatTimestamp(cue.end, ",")}`;
      const prefix =
        cue.speaker === null ? "" : `[${speakerLabel(cue.speaker, speakerNames)}] `;
      return `${index + 1}\n${time}\n${prefix}${cue.text}\n`;
    })
    .join("\n");
}

export function toVtt(cues: Cue[], speakerNames: SpeakerNames = {}): string {
  const body = cues
    .map((cue) => {
      const line =
        cue.speaker === null
          ? cue.text
          : `<v ${speakerLabel(cue.speaker, speakerNames)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")}>${cue.text}`;
      return `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${line}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function toTxt(segments: Segment[], speakerNames: SpeakerNames = {}): string {
  return segments
    .map((segment) => {
      const prefix =
        segment.speaker === null
          ? ""
          : `${speakerLabel(segment.speaker, speakerNames)}: `;
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
