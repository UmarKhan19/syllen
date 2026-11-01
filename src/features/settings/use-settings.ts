import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ToolsStatus, UpdateResult } from "../../lib/wire-types";

export function useSettings(open: boolean) {
  const [speakerLabels, setSpeakerLabels] = useState(() => {
    try {
      return localStorage.getItem("ytt.speakerLabels") !== "false";
    } catch {
      return true;
    }
  });
  const speakerLabelsRef = useRef(speakerLabels);
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateOk, setUpdateOk] = useState(true);
  const [latestYtDlp, setLatestYtDlp] = useState<string | null>(null);
  const [checkingLatest, setCheckingLatest] = useState(false);
  const [latestError, setLatestError] = useState<string | null>(null);

  useEffect(() => {
    speakerLabelsRef.current = speakerLabels;
    try {
      localStorage.setItem("ytt.speakerLabels", String(speakerLabels));
    } catch {
      // settings still apply for this session
    }
  }, [speakerLabels]);

  useEffect(() => {
    let disposed = false;
    invoke<ToolsStatus>("check_tools")
      .then((status) => {
        if (!disposed) setTools(status);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    invoke<ToolsStatus>("check_tools")
      .then((status) => {
        if (!disposed) setTools(status);
      })
      .catch(() => undefined);
    setCheckingLatest(true);
    setLatestError(null);
    invoke<string>("latest_yt_dlp_version")
      .then((version) => {
        if (!disposed) setLatestYtDlp(version);
      })
      .catch((problem) => {
        if (!disposed) setLatestError(String(problem));
      })
      .finally(() => {
        if (!disposed) setCheckingLatest(false);
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const toggleSpeakerLabels = () => {
    const next = !speakerLabelsRef.current;
    speakerLabelsRef.current = next;
    setSpeakerLabels(next);
  };

  async function updateYtDlp() {
    setUpdating(true);
    setUpdateMessage(null);
    try {
      const result = await invoke<UpdateResult>("update_yt_dlp");
      setUpdateOk(result.ok);
      setUpdateMessage(result.message);
      if (result.version) {
        setLatestYtDlp(result.version);
        setLatestError(null);
      }
      setTools(await invoke<ToolsStatus>("check_tools"));
    } catch (problem) {
      setUpdateOk(false);
      setUpdateMessage(String(problem));
    } finally {
      setUpdating(false);
    }
  }

  const missing = useMemo(() => {
    if (!tools) return [];
    return [
      !(tools.ffmpeg && tools.ffprobe) && "ffmpeg + ffprobe",
      !tools.node && "Node.js",
      !tools.sidecar && "the speech sidecar (run npm run sidecar:install)",
    ].filter(Boolean) as string[];
  }, [tools]);
  const installedYtDlp = tools?.ytDlpVersion ?? null;

  return {
    speakerLabels,
    speakerLabelsRef,
    toggleSpeakerLabels,
    tools,
    missing,
    ytDlpMissing: Boolean(tools && !tools.ytDlp),
    updating,
    updateMessage,
    updateOk,
    latestYtDlp,
    checkingLatest,
    latestError,
    upToDate: Boolean(installedYtDlp && latestYtDlp && installedYtDlp === latestYtDlp),
    hasUpdate: Boolean(installedYtDlp && latestYtDlp && installedYtDlp !== latestYtDlp),
    updateYtDlp,
  };
}
