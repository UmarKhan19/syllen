import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RetrySpeakerAnalysis } from "../../app";

describe("speaker-analysis retry", () => {
  it("blocks retry while word corrections are open and allows it after save or cancel", () => {
    const retry = vi.fn();
    const editing = RetrySpeakerAnalysis({ wordEditing: true, onRetry: retry });
    const editingHtml = renderToStaticMarkup(
      createElement(RetrySpeakerAnalysis, { wordEditing: true, onRetry: retry }),
    );
    const editingButton = (editing.props.children as ReactNode[])[1] as ReactElement<{
      disabled?: boolean;
      onClick: () => void;
    }>;

    expect(editingHtml).toContain('disabled=""');
    expect(editingHtml).toContain("Save or cancel word corrections before retrying.");
    editingButton.props.onClick();
    expect(retry).not.toHaveBeenCalled();

    const failedSave = renderToStaticMarkup(
      createElement(RetrySpeakerAnalysis, { wordEditing: true, onRetry: retry }),
    );
    expect(failedSave).toContain('disabled=""');

    const saved = RetrySpeakerAnalysis({ wordEditing: false, onRetry: retry });
    const savedButton = (saved.props.children as ReactNode[])[1] as ReactElement<{
      disabled?: boolean;
      onClick: () => void;
    }>;
    expect(
      renderToStaticMarkup(
        createElement(RetrySpeakerAnalysis, { wordEditing: false, onRetry: retry }),
      ),
    ).not.toContain('disabled=""');
    savedButton.props.onClick();
    expect(retry).toHaveBeenCalledOnce();
  });
});
