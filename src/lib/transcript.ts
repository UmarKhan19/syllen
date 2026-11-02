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

export type SpeakerNames = Partial<Record<number, string>>;

export const speakerLabel = (speaker: number | null, speakerNames: SpeakerNames = {}) =>
  speaker === null ? "Unknown speaker" : speakerNames[speaker]?.trim() || `Speaker ${speaker + 1}`;

const PUNCTUATION_ONLY = /^[.,!?;:…)»"']+$/;

export function isPunctuation(text: string): boolean {
  return PUNCTUATION_ONLY.test(text);
}

export function segmentIndexAt(segments: Segment[], time: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segments[middle].start <= time) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

export function wordIndexAt(segment: Segment, time: number): number {
  let low = 0;
  let high = segment.words.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segment.words[middle].start <= time) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

export function joinWords(words: Word[]): string {
  return words.reduce((text, word) => {
    if (!text) return word.text;
    if (PUNCTUATION_ONLY.test(word.text)) return text + word.text;
    return `${text} ${word.text}`;
  }, "");
}

export function replaceWordText(
  segments: Segment[],
  segmentIndex: number,
  wordIndex: number,
  text: string,
): Segment[] {
  const word = segments[segmentIndex]?.words[wordIndex];
  const corrected = text.trim();
  if (!word || !corrected || corrected.length > 512 || /[\u0000-\u001f\u007f]/u.test(corrected)) {
    throw new Error("Enter a non-empty correction of 512 characters or fewer.");
  }
  return segments.map((segment, index) => {
    if (index !== segmentIndex) return segment;
    const words = segment.words.map((item, itemIndex) =>
      itemIndex === wordIndex ? { ...item, text: corrected } : item,
    );
    return { ...segment, words, text: joinWords(words) };
  });
}

export function sameWordTexts(left: Word[], right: Word[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (word, index) =>
        word.text === right[index].text &&
        word.start === right[index].start &&
        word.end === right[index].end,
    )
  );
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

function paragraphBreak(segment: Segment, gap: number): boolean {
  const span = segment.end - segment.start;
  if (span >= 60 || segment.text.length >= 800) return true;
  const last = segment.words[segment.words.length - 1];
  return SENTENCE_END.test(last.text) && (gap >= 1 || span >= 25 || segment.text.length >= 300);
}

export function mergeWords(words: Word[], turns: Turn[], maxGap = 2): Segment[] {
  const segments: Segment[] = [];
  for (const word of words) {
    const speaker = speakerAt(word, turns);
    const last = segments[segments.length - 1];
    const gap = last ? word.start - last.end : 0;
    if (last && last.speaker === speaker && gap <= maxGap && !paragraphBreak(last, gap)) {
      last.words.push(word);
      last.end = word.end;
      last.text = joinWords(last.words);
    } else {
      segments.push({ speaker, start: word.start, end: word.end, text: word.text, words: [word] });
    }
  }
  return segments;
}
