import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message } from "@tauri-apps/plugin-dialog";

export function useUnsavedWordGuard(
  editing: { current: boolean },
  saving: { current: boolean },
  dirty: { current: boolean },
) {
  useEffect(() => {
    let disposed = false;
    let prompting = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (!editing.current || !dirty.current) return;
        event.preventDefault();
        if (disposed || prompting) return;
        prompting = true;
        void (async () => {
          if (saving.current) {
            await message(
              "A word correction is being saved. Wait for it to finish before closing.",
              { title: "Save in progress", kind: "info" },
            );
            return;
          }
          const discard = await ask("Discard your unsaved word corrections and close Syllen?", {
            title: "Unsaved word corrections",
            kind: "warning",
            okLabel: "Discard changes",
            cancelLabel: "Keep editing",
          });
          if (!discard) return;
          if (saving.current)
            await message("A word correction save started. Wait for it to finish before closing.", {
              title: "Save in progress",
              kind: "info",
            });
          else if (editing.current && dirty.current) await getCurrentWindow().destroy();
          else await getCurrentWindow().close();
        })()
          .catch(() => undefined)
          .finally(() => {
            prompting = false;
          });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [editing, saving, dirty]);
}
