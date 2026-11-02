export function wordTabStopIndex(
  segment: number,
  wordCount: number,
  focusedWord: { segment: number; word: number },
): number | null {
  if (wordCount === 0) return null;
  return focusedWord.segment === segment ? Math.min(focusedWord.word, wordCount - 1) : 0;
}

export function wordNavigationTarget(
  key: string,
  segment: number,
  word: number,
  wordCounts: number[],
): { segment: number; word: number } | null {
  const count = wordCounts[segment] ?? 0;
  if (key === "ArrowLeft" && word > 0) return { segment, word: word - 1 };
  if (key === "ArrowRight" && word + 1 < count) return { segment, word: word + 1 };
  if (key === "ArrowUp") {
    for (let targetSegment = segment - 1; targetSegment >= 0; targetSegment--) {
      if (wordCounts[targetSegment] > 0) {
        return {
          segment: targetSegment,
          word: Math.min(word, wordCounts[targetSegment] - 1),
        };
      }
    }
  }
  if (key === "ArrowDown") {
    for (let targetSegment = segment + 1; targetSegment < wordCounts.length; targetSegment++) {
      if (wordCounts[targetSegment] > 0) {
        return {
          segment: targetSegment,
          word: Math.min(word, wordCounts[targetSegment] - 1),
        };
      }
    }
  }
  return null;
}
