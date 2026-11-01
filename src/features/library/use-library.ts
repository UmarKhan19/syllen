import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LibraryItem, SavedTranscript } from "../../lib/wire-types";

export function useLibrary() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const refresh = useCallback(() => {
    invoke<LibraryItem[]>("list_library")
      .then((next) => {
        setItems(next);
        setError(null);
      })
      .catch((problem) => setError(String(problem)))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => refresh(), [refresh]);

  async function load(item: LibraryItem): Promise<SavedTranscript> {
    setOpeningId(item.id);
    setError(null);
    try {
      return await invoke<SavedTranscript>("load_transcript", { id: item.id });
    } catch (problem) {
      setError(String(problem));
      throw problem;
    } finally {
      setOpeningId(null);
    }
  }

  async function remove(item: LibraryItem) {
    if (deleteBusy) return false;
    setDeleteBusy(true);
    try {
      await invoke("delete_transcript", { id: item.id });
      setDeletingId(null);
      refresh();
      return true;
    } catch (problem) {
      setError(String(problem));
      return false;
    } finally {
      setDeleteBusy(false);
    }
  }

  return {
    items,
    ready,
    error,
    setError,
    openingId,
    deletingId,
    setDeletingId,
    deleteBusy,
    refresh,
    load,
    remove,
  };
}
