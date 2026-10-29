import { describe, expect, it } from "vitest";
import {
  buildCues,
  isPunctuation,
  joinWords,
  mergeWords,
  segmentIndexAt,
  speakerAt,
  toSrt,
  toTxt,
  toVtt,
  wordIndexAt,
  type Turn,
  type Word,
} from "./merge";

const words: Word[] = [
  { text: "Hello", start: 0, end: 0.4 },
  { text: "there.", start: 0.4, end: 0.9 },
  { text: "How", start: 1.4, end: 1.6 },
  { text: "are", start: 1.6, end: 1.8 },
  { text: "you?", start: 1.8, end: 2.1 },
];

const turns: Turn[] = [
  { speaker: 0, start: 0, end: 1.0 },
  { speaker: 1, start: 1.2, end: 2.5 },
];

describe("speakerAt", () => {
  it("picks the turn with the largest overlap", () => {
    expect(speakerAt(words[0], turns)).toBe(0);
    expect(speakerAt(words[4], turns)).toBe(1);
  });

  it("falls back to a nearby turn inside the gap window", () => {
    expect(speakerAt({ text: "Hm", start: 1.05, end: 1.15 }, turns)).toBe(0);
  });

  it("returns null when no turn is close", () => {
    expect(speakerAt({ text: "Hm", start: 9, end: 9.2 }, turns)).toBeNull();
  });
});

describe("mergeWords", () => {
  it("groups consecutive words by speaker", () => {
    const segments = mergeWords(words, turns);
    expect(segments.map((segment) => segment.speaker)).toEqual([0, 1]);
    expect(segments[0].text).toBe("Hello there.");
    expect(segments[1].text).toBe("How are you?");
  });

  it("keeps one unlabelled segment when diarization is empty", () => {
    const segments = mergeWords(words, []);
    expect(segments).toHaveLength(1);
    expect(segments[0].speaker).toBeNull();
  });

  it("breaks long runs at sentence ends instead of a fixed interval", () => {
    const spoken: Word[] = [];
    let clock = 0;
    for (let sentence = 0; sentence < 12; sentence += 1) {
      for (let index = 0; index < 5; index += 1) {
        spoken.push({
          text: index === 4 ? `end${sentence}.` : `word${sentence}${index}`,
          start: clock,
          end: clock + 0.4,
        });
        clock += 0.5;
      }
    }
    const segments = mergeWords(spoken, []);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.words[0].text).toMatch(/^word/);
      expect(segment.words[segment.words.length - 1].text).toMatch(/\.$/);
      expect(segment.end - segment.start).toBeLessThan(40);
    }
    expect(joinWords(segments.flatMap((segment) => segment.words))).toBe(
      joinWords(spoken),
    );
  });

  it("caps punctuation-free speech instead of one giant block", () => {
    const run = Array.from({ length: 400 }, (_, index) => ({
      text: `word${index}`,
      start: index * 0.5,
      end: index * 0.5 + 0.4,
    }));
    expect(mergeWords(run, []).length).toBeGreaterThan(1);
  });
});

describe("captions", () => {
  it("splits long runs into cues and writes SRT", () => {
    const long = Array.from({ length: 40 }, (_, index) => ({
      text: `word${index}`,
      start: index * 0.5,
      end: index * 0.5 + 0.4,
    }));
    const segments = mergeWords(long, [{ speaker: 0, start: 0, end: 30 }]);
    const cues = buildCues(segments);
    expect(cues.length).toBeGreaterThan(1);
    cues.forEach((cue) => expect(cue.text.length).toBeLessThanOrEqual(90));
    const srt = toSrt(cues);
    expect(srt).toContain("00:00:00,000 -->");
    expect(srt).toContain("[Speaker 1]");
  });

  it("writes a readable text export", () => {
    const segments = mergeWords(words, turns);
    expect(toTxt(segments)).toContain("[0:00] Speaker 1: Hello there.");
  });

  it("uses renamed speakers in every export and escapes VTT voice names", () => {
    const segments = mergeWords(words, turns);
    const cues = buildCues(segments);
    const speakerNames = { 0: "Eric & <guest>" };

    expect(toTxt(segments, speakerNames)).toContain(
      "[0:00] Eric & <guest>: Hello there.",
    );
    expect(toSrt(cues, speakerNames)).toContain("[Eric & <guest>]");
    expect(toVtt(cues, speakerNames)).toContain(
      "<v Eric &amp; &lt;guest&gt;>Hello there.",
    );
  });

  it("omits speaker prefixes when labeling is off", () => {
    const segments = mergeWords(words, []);
    expect(toTxt(segments)).toContain("[0:00] Hello there.");
    expect(toSrt(buildCues(segments))).not.toContain("Unknown speaker");
  });
});

describe("playback sync", () => {
  const segments = mergeWords(words, turns);

  it("finds the segment that is being spoken", () => {
    expect(segmentIndexAt([], 1)).toBe(-1);
    expect(segmentIndexAt(segments, 0)).toBe(0);
    expect(segmentIndexAt(segments, 0.5)).toBe(0);
    expect(segmentIndexAt(segments, 1.5)).toBe(1);
    expect(segmentIndexAt(segments, 99)).toBe(segments.length - 1);
    expect(segmentIndexAt(segments, -1)).toBe(-1);
  });

  it("finds the word inside a segment, holding it through pauses", () => {
    const segment = segments[0];
    expect(wordIndexAt(segment, 0)).toBe(0);
    expect(wordIndexAt(segment, 0.5)).toBe(1);
    expect(wordIndexAt(segment, 1.1)).toBe(1);
    expect(wordIndexAt(segment, -0.1)).toBe(-1);
  });

  it("does not put a space before punctuation", () => {
    expect(isPunctuation(".")).toBe(true);
    expect(isPunctuation("you?")).toBe(false);
  });
});
