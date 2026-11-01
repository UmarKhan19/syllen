import { describe, expect, it } from "vitest";
import { buildCues, toSrt, toTxt, toVtt } from "./captions";
import { mergeWords, type Word } from "./transcript";

const words: Word[] = [
  { text: "Hello", start: 0, end: 0.4 },
  { text: "there.", start: 0.4, end: 0.9 },
  { text: "How", start: 1.4, end: 1.6 },
  { text: "are", start: 1.6, end: 1.8 },
  { text: "you?", start: 1.8, end: 2.1 },
];
const turns = [{ speaker: 0, start: 0, end: 1.0 }, { speaker: 1, start: 1.2, end: 2.5 }];

describe("captions", () => {
  it("splits long runs into cues and writes SRT", () => {
    const long = Array.from({ length: 40 }, (_, index) => ({ text: `word${index}`, start: index * 0.5, end: index * 0.5 + 0.4 }));
    const cues = buildCues(mergeWords(long, [{ speaker: 0, start: 0, end: 30 }]));
    expect(cues.length).toBeGreaterThan(1);
    cues.forEach((cue) => expect(cue.text.length).toBeLessThanOrEqual(90));
    const srt = toSrt(cues);
    expect(srt).toContain("00:00:00,000 -->");
    expect(srt).toContain("[Speaker 1]");
  });
  it("writes a readable text export", () => {
    expect(toTxt(mergeWords(words, turns))).toContain("[0:00] Speaker 1: Hello there.");
  });
  it("uses renamed speakers in every export and escapes VTT voice names", () => {
    const segments = mergeWords(words, turns);
    const cues = buildCues(segments);
    const speakerNames = { 0: "Eric & <guest>" };
    expect(toTxt(segments, speakerNames)).toContain("[0:00] Eric & <guest>: Hello there.");
    expect(toSrt(cues, speakerNames)).toContain("[Eric & <guest>]");
    expect(toVtt(cues, speakerNames)).toContain("<v Eric &amp; &lt;guest&gt;>Hello there.");
  });
  it("omits speaker prefixes when labeling is off", () => {
    const segments = mergeWords(words, []);
    expect(toTxt(segments)).toContain("[0:00] Hello there.");
    expect(toSrt(buildCues(segments))).not.toContain("Unknown speaker");
  });
});
