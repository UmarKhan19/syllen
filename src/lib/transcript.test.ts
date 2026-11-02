import { describe, expect, it } from "vitest";
import { toSrt, toTxt, toVtt, buildCues } from "./captions";
import {
  isPunctuation,
  joinWords,
  mergeWords,
  replaceWordText,
  sameWordTexts,
  segmentIndexAt,
  speakerAt,
  wordIndexAt,
  type Turn,
  type Word,
} from "./transcript";

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
    expect(joinWords(segments.flatMap((segment) => segment.words))).toBe(joinWords(spoken));
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

describe("word corrections", () => {
  it("replaces text without moving timing or speaker and keeps joined text/export aligned", () => {
    const before = mergeWords(words, turns);
    const corrected = replaceWordText(before, 0, 1, "there, indeed.");
    expect(corrected[0].speaker).toBe(before[0].speaker);
    expect(corrected[0].start).toBe(before[0].start);
    expect(corrected[0].end).toBe(before[0].end);
    expect(corrected[0].words[1]).toEqual({ text: "there, indeed.", start: 0.4, end: 0.9 });
    expect(corrected[0].text).toBe("Hello there, indeed.");
    expect(toTxt(corrected)).toContain("Hello there, indeed.");
    expect(toSrt(buildCues(corrected))).toContain("Hello there, indeed.");
    expect(toVtt(buildCues(corrected))).toContain("Hello there, indeed.");
    expect(before[0].text).toBe("Hello there.");
  });
  it("rejects blank or control-character text instead of dropping a word", () => {
    const segments = mergeWords(words, turns);
    expect(() => replaceWordText(segments, 0, 0, "  ")).toThrow();
    expect(() => replaceWordText(segments, 0, 0, "hello\nworld")).toThrow();
    expect(() => replaceWordText(segments, 9, 0, "hello")).toThrow();
  });
  it("detects unchanged corrections by text and original timing", () => {
    expect(sameWordTexts(words, [...words])).toBe(true);
    const corrected = replaceWordText(mergeWords(words, []), 0, 0, "Hi").flatMap(
      (segment) => segment.words,
    );
    expect(sameWordTexts(words, corrected)).toBe(false);
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
    expect(wordIndexAt(segments[0], 0)).toBe(0);
    expect(wordIndexAt(segments[0], 0.5)).toBe(1);
    expect(wordIndexAt(segments[0], 1.1)).toBe(1);
    expect(wordIndexAt(segments[0], -0.1)).toBe(-1);
  });
  it("does not put a space before punctuation", () => {
    expect(isPunctuation(".")).toBe(true);
    expect(isPunctuation("you?")).toBe(false);
  });
});
