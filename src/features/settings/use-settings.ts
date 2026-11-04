import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThermalStatus, ToolsStatus, UpdateResult } from "../../lib/wire-types";
import { persistResourcePreset, type ResourcePreset, readResourcePreset } from "./resource-preset";
import {
  persistThermalGuard,
  readThermalGuard,
  unavailableThermalStatus,
  validateThermalStatus,
} from "./thermal-guard";

async function readThermalStatus(): Promise<ThermalStatus> {
  let timeout = 0;
  try {
    const status = await Promise.race([
      invoke<ThermalStatus>("thermal_status"),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error("Temperature check timed out.")), 2500);
      }),
    ]);
    return validateThermalStatus(status);
  } finally {
    window.clearTimeout(timeout);
  }
}

export function useSettings(open: boolean) {
  const [speakerLabels, setSpeakerLabels] = useState(() => {
    try {
      return localStorage.getItem("ytt.speakerLabels") !== "false";
    } catch {
      return true;
    }
  });
  const speakerLabelsRef = useRef(speakerLabels);
  const [resourcePreset, setResourcePreset] = useState(readResourcePreset);
  const [thermalGuardEnabled, setThermalGuardEnabled] = useState(readThermalGuard);
  const [thermalStatus, setThermalStatus] = useState<ThermalStatus | null>(null);
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
    persistResourcePreset(resourcePreset);
  }, [resourcePreset]);

  useEffect(() => {
    persistThermalGuard(thermalGuardEnabled);
  }, [thermalGuardEnabled]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let checking = false;
    setThermalStatus(null);
    const poll = async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await readThermalStatus();
        if (!disposed) setThermalStatus(status);
      } catch (problem) {
        if (!disposed) setThermalStatus(unavailableThermalStatus(String(problem)));
      } finally {
        checking = false;
      }
    };
    void poll();
    const interval = window.setInterval(poll, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [open]);

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
    resourcePreset,
    setResourcePreset: (preset: ResourcePreset) => setResourcePreset(preset),
    thermalGuardEnabled,
    setThermalGuardEnabled,
    thermalStatus,
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
