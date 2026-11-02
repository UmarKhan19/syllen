export interface WordCorrectionRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface WordCorrectionPosition {
  left: number;
  top: number;
  placement: "above" | "below";
  maxHeight?: number;
  scrollBy?: number;
}

export function positionWordCorrection(
  anchor: WordCorrectionRect,
  popover: Pick<WordCorrectionRect, "width" | "height">,
  viewport: { width: number; height: number; topInset: number; scrollAmount?: number },
  allowScroll = true,
): WordCorrectionPosition | null {
  const margin = 8;
  const gap = 8;
  const topInset = Math.max(margin, viewport.topInset);
  if (
    anchor.right <= 0 ||
    anchor.left >= viewport.width ||
    anchor.bottom <= topInset ||
    anchor.top >= viewport.height
  ) {
    return null;
  }

  const width = Math.min(popover.width, Math.max(0, viewport.width - margin * 2));
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - width / 2, margin),
    viewport.width - width - margin,
  );
  const aboveTop = anchor.top - gap - popover.height;
  const belowTop = anchor.bottom + gap;
  const minTop = topInset + margin;
  const maxBottom = viewport.height - margin;
  const aboveSpace = Math.max(0, anchor.top - gap - minTop);
  const belowSpace = Math.max(0, maxBottom - belowTop);
  const aboveFits = aboveSpace >= popover.height;
  const belowFits = belowSpace >= popover.height;
  const placement = aboveFits || (!belowFits && aboveSpace >= belowSpace) ? "above" : "below";

  const maxHeight = placement === "above" ? aboveSpace : belowSpace;
  const preferredTop =
    placement === "above" ? (aboveFits ? aboveTop : anchor.top - gap - maxHeight) : belowTop;
  const needsScroll = !aboveFits && !belowFits && (viewport.scrollAmount ?? 0) > 0;
  if (!aboveFits && !belowFits && maxHeight === 0 && !(allowScroll && needsScroll)) return null;

  return {
    left,
    top: preferredTop,
    placement,
    ...(!aboveFits && !belowFits ? { maxHeight } : {}),
    ...(allowScroll && needsScroll ? { scrollBy: viewport.scrollAmount } : {}),
  };
}
