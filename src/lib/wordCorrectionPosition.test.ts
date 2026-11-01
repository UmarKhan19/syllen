import { describe, expect, it } from "vitest";
import { positionWordCorrection } from "./wordCorrectionPosition";

const viewport = { width: 800, height: 600, topInset: 116 };
const popover = { width: 200, height: 80 };

describe("positionWordCorrection", () => {
  it("places above the word when there is room", () => {
    expect(
      positionWordCorrection(
        { top: 300, right: 340, bottom: 320, left: 300, width: 40, height: 20 },
        popover,
        viewport,
      ),
    ).toEqual({ left: 220, top: 212, placement: "above" });
  });

  it("flips below when the sticky header leaves too little room above", () => {
    expect(
      positionWordCorrection(
        { top: 130, right: 340, bottom: 150, left: 300, width: 40, height: 20 },
        popover,
        viewport,
      ),
    ).toEqual({ left: 220, top: 158, placement: "below" });
  });

  it("keeps the first word's popover below the visible in-flow player", () => {
    expect(
      positionWordCorrection(
        { top: 414, right: 340, bottom: 434, left: 300, width: 40, height: 20 },
        popover,
        { width: 1040, height: 780, topInset: 402 },
      ),
    ).toEqual({ left: 220, top: 442, placement: "below" });
  });

  it("requests one dock-clearing viewport scroll instead of clamping over the anchor", () => {
    const crampedAnchor = {
      top: 487,
      right: 140,
      bottom: 510,
      left: 100,
      width: 40,
      height: 23,
    };
    const compactPopover = { width: 260, height: 92 };
    const crampedViewport = {
      width: 720,
      height: 560,
      topInset: 441,
      scrollAmount: 281,
    };

    expect(
      positionWordCorrection(crampedAnchor, compactPopover, crampedViewport),
    ).toMatchObject({ placement: "below", maxHeight: 34, scrollBy: 281 });

    const scrolled = positionWordCorrection(
      { ...crampedAnchor, top: 206, bottom: 229 },
      compactPopover,
      { ...crampedViewport, topInset: 160 },
      false,
    );
    expect(scrolled).toEqual({ left: 8, top: 237, placement: "below" });
    expect(scrolled!.top).toBeGreaterThanOrEqual(229 + 8);
    expect(scrolled!.top + compactPopover.height).toBeLessThanOrEqual(560 - 8);
  });

  it("bounds the popover to real side-room when viewport scrolling is unavailable", () => {
    const bounded = positionWordCorrection(
      { top: 487, right: 140, bottom: 510, left: 100, width: 40, height: 23 },
      { width: 260, height: 92 },
      { width: 720, height: 560, topInset: 441 },
      false,
    );
    expect(bounded).toEqual({ left: 8, top: 518, placement: "below", maxHeight: 34 });
    expect(bounded!.top).toBeGreaterThanOrEqual(510 + 8);
  });

  it("still requests dock clearance when neither side has current room", () => {
    expect(
      positionWordCorrection(
        { top: 542, right: 140, bottom: 550, left: 100, width: 40, height: 8 },
        { width: 260, height: 92 },
        { width: 720, height: 560, topInset: 540, scrollAmount: 281 },
      ),
    ).toMatchObject({ scrollBy: 281, maxHeight: 0 });
  });

  it("clamps to narrow viewports and horizontal edges", () => {
    expect(
      positionWordCorrection(
        { top: 300, right: 24, bottom: 320, left: 8, width: 16, height: 20 },
        { width: 500, height: 80 },
        { width: 720, height: 560, topInset: 116 },
      )?.left,
    ).toBe(8);
    expect(
      positionWordCorrection(
        { top: 300, right: 790, bottom: 320, left: 750, width: 40, height: 20 },
        popover,
        viewport,
      )?.left,
    ).toBe(592);
  });

  it("hides the popover when its anchor is behind sticky chrome or offscreen", () => {
    expect(
      positionWordCorrection(
        { top: 80, right: 340, bottom: 100, left: 300, width: 40, height: 20 },
        popover,
        viewport,
      ),
    ).toBeNull();
    expect(
      positionWordCorrection(
        { top: 620, right: 340, bottom: 640, left: 300, width: 40, height: 20 },
        popover,
        viewport,
      ),
    ).toBeNull();
  });
});
