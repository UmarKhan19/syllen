import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  positionWordCorrection,
  type WordCorrectionPosition,
} from "./word-correction-position";

export function WordCorrectionPopover({
  anchor,
  focusToken,
  inputRef,
  cancelRef,
  value,
  label,
  error,
  onChange,
  onApply,
  onCancel,
}: {
  anchor: HTMLButtonElement;
  focusToken: number;
  inputRef: RefObject<HTMLInputElement | null>;
  cancelRef: RefObject<HTMLButtonElement | null>;
  value: string;
  label: string;
  error: string | null;
  onChange: (value: string) => void;
  onApply: (restoreFocus?: boolean) => unknown;
  onCancel: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const suppressBlurRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const focusedTokenRef = useRef(-1);
  const roomScrollKeyRef = useRef<string | null>(null);
  const [position, setPosition] = useState<WordCorrectionPosition | null>(null);

  const updatePosition = useCallback(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    if (!anchor.isConnected) {
      suppressBlurRef.current = true;
      setPosition(null);
      if (popover.contains(document.activeElement)) {
        cancelRef.current?.focus({ preventScroll: true });
        restoreFocusRef.current = false;
      }
      return;
    }
    const topbar = document.querySelector<HTMLElement>("[data-app-topbar]")?.getBoundingClientRect();
    const readingDock = document
      .querySelector<HTMLElement>("[data-reading-dock]")
      ?.getBoundingClientRect();
    const topInset = Math.max(
      topbar?.bottom ?? 0,
      readingDock && readingDock.bottom > 0 && readingDock.top < window.innerHeight
        ? Math.min(readingDock.bottom, window.innerHeight)
        : 0,
    );
    const rect = popover.getBoundingClientRect();
    const style = window.getComputedStyle(popover);
    const intrinsicHeight = Math.max(
      rect.height,
      popover.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
    );
    const roomScrollKey = `${focusToken}:${window.innerWidth}x${window.innerHeight}`;
    const allowRoomScroll = roomScrollKeyRef.current !== roomScrollKey;
    const next = positionWordCorrection(
      anchor.getBoundingClientRect(),
      { width: rect.width, height: intrinsicHeight },
      {
        width: window.innerWidth,
        height: window.innerHeight,
        topInset,
        scrollAmount: readingDock
          ? Math.max(0, readingDock.top - (topbar?.bottom ?? 0))
          : 0,
      },
      allowRoomScroll,
    );
    if (next?.scrollBy && allowRoomScroll) {
      roomScrollKeyRef.current = roomScrollKey;
      setPosition(null);
      window.scrollBy({ top: next.scrollBy, behavior: "auto" });
      requestAnimationFrame(updatePosition);
      return;
    }
    suppressBlurRef.current = next === null;
    setPosition((current) =>
      current?.left === next?.left &&
      current?.top === next?.top &&
      current?.maxHeight === next?.maxHeight
        ? current
        : next,
    );
    if (!next && popover.contains(document.activeElement)) {
      restoreFocusRef.current = true;
      anchor.focus({ preventScroll: true });
    } else if (next && restoreFocusRef.current) {
      if (document.activeElement === document.body || document.activeElement === anchor) {
        restoreFocusRef.current = false;
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
      } else if (document.activeElement !== inputRef.current) {
        restoreFocusRef.current = false;
      }
    }
  }, [anchor, cancelRef, focusToken, inputRef]);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    observer.observe(popover);
    const readingDock = document.querySelector<HTMLElement>("[data-reading-dock]");
    if (readingDock) observer.observe(readingDock);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchor, updatePosition]);

  useLayoutEffect(() => {
    if (position && focusToken !== focusedTokenRef.current) {
      focusedTokenRef.current = focusToken;
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
  }, [focusToken, inputRef, position]);

  function onInputBlur(target: EventTarget | null) {
    if (suppressBlurRef.current) {
      restoreFocusRef.current = true;
      return;
    }
    const element = target instanceof HTMLElement ? target : null;
    if (
      element?.closest(
        '[data-word-correction-target], [data-word-correction-action="save"], [data-word-correction-action="cancel"], [data-word-correction-action="close"]',
      )
    ) {
      return;
    }
    applyCurrent(false);
  }

  function applyCurrent(restoreFocus: boolean) {
    const applied = onApply(restoreFocus);
    if (applied) suppressBlurRef.current = true;
    return applied;
  }

  function cancelCurrent() {
    suppressBlurRef.current = true;
    onCancel();
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      applyCurrent(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelCurrent();
    } else if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) anchor.focus({ preventScroll: true });
      else closeButtonRef.current?.focus({ preventScroll: true });
    }
  }

  function onCloseKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelCurrent();
    } else if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      inputRef.current?.focus({ preventScroll: true });
    }
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-50 grid w-[min(400px,calc(100vw_-_16px))] gap-3 overflow-y-auto rounded-control border border-rule bg-sheet px-3 pt-15 pb-3 text-ink shadow-word-correction"
      role="dialog"
      aria-modal="false"
      aria-label={`Correct ${label}`}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <input
        ref={inputRef}
        className="w-full max-w-full min-h-10 box-border wrap-anywhere rounded-[5px] border border-rule bg-paper px-2.5 py-1.75 font-ui text-[16px] leading-[1.5] text-ink shadow-none appearance-none focus:border-transparent focus:outline-2 focus:outline-offset-2 focus:outline-ink"
        value={value}
        aria-label={`Correct ${label}`}
        aria-invalid={Boolean(error)}
        aria-describedby={[
          "word-correction-popover-hint",
          error ? "word-correction-popover-error" : null,
        ].filter(Boolean).join(" ")}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onInputBlur(event.relatedTarget)}
        onKeyDown={onInputKeyDown}
        maxLength={512}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        ref={closeButtonRef}
        type="button"
        className="absolute top-3 right-3 grid size-8 shrink-0 basis-8 cursor-pointer place-items-center rounded-control border border-rule bg-transparent p-0 text-ink-2 transition-[color,background,border-color] duration-150 ease-[ease] hover:border-rule-strong hover:bg-sheet hover:text-ink"
        data-word-correction-action="close"
        aria-label="Close word editor"
        onPointerDown={() => { suppressBlurRef.current = true; }}
        onClick={cancelCurrent}
        onKeyDown={onCloseKeyDown}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      <span
        id="word-correction-popover-hint"
        className="flex items-center gap-1.75 font-ui text-fine leading-[1.35] text-ink-2"
      >
        <span><kbd className="border-0 bg-transparent p-0 font-mono text-label text-ink-3">Enter</kbd> applies</span>
        <span aria-hidden="true" className="text-rule">·</span>
        <span><kbd className="border-0 bg-transparent p-0 font-mono text-label text-ink-3">Esc</kbd> restores</span>
      </span>
      {error && (
        <span
          id="word-correction-popover-error"
          className="block wrap-anywhere text-fine leading-[1.4] text-alert"
        >
          {error}
        </span>
      )}
    </div>,
    document.body,
  );
}
