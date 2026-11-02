import { describe, expect, it } from "vitest";
import { wordNavigationTarget, wordTabStopIndex } from "./word-navigation";

describe("wordNavigationTarget", () => {
  const counts = [3, 1];

  it("moves within and between paragraphs, clamping to the available word", () => {
    expect(wordNavigationTarget("ArrowRight", 0, 1, counts)).toEqual({ segment: 0, word: 2 });
    expect(wordNavigationTarget("ArrowDown", 0, 2, counts)).toEqual({ segment: 1, word: 0 });
    expect(wordNavigationTarget("ArrowUp", 1, 0, counts)).toEqual({ segment: 0, word: 0 });
  });

  it("leaves boundary keys unhandled", () => {
    expect(wordNavigationTarget("ArrowLeft", 0, 0, counts)).toBeNull();
    expect(wordNavigationTarget("ArrowRight", 1, 0, counts)).toBeNull();
  });

  it("skips paragraphs without word controls in either direction", () => {
    const countsWithHiddenAndEmptyParagraphs = [3, 0, 2, 0];
    expect(wordNavigationTarget("ArrowDown", 0, 2, countsWithHiddenAndEmptyParagraphs)).toEqual({
      segment: 2,
      word: 1,
    });
    expect(wordNavigationTarget("ArrowUp", 2, 1, countsWithHiddenAndEmptyParagraphs)).toEqual({
      segment: 0,
      word: 1,
    });
    expect(wordNavigationTarget("ArrowDown", 2, 0, countsWithHiddenAndEmptyParagraphs)).toBeNull();
  });
});

describe("wordTabStopIndex", () => {
  it("clamps stale focus after a paragraph shrinks and keeps other paragraphs reachable", () => {
    const staleFocus = { segment: 0, word: 2 };
    expect(wordTabStopIndex(0, 2, staleFocus)).toBe(1);
    expect(wordTabStopIndex(1, 3, staleFocus)).toBe(0);
  });

  it("returns no tab stop for an empty paragraph", () => {
    expect(wordTabStopIndex(0, 0, { segment: 0, word: 2 })).toBeNull();
  });
});
