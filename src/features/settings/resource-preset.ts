export const RESOURCE_PRESETS = ["performance", "balanced", "battery"] as const;
export type ResourcePreset = (typeof RESOURCE_PRESETS)[number];

export function readResourcePreset(): ResourcePreset {
  try {
    const saved = localStorage.getItem("ytt.resourcePreset");
    return RESOURCE_PRESETS.find((preset) => preset === saved) ?? "balanced";
  } catch {
    return "balanced";
  }
}

export function persistResourcePreset(preset: ResourcePreset) {
  try {
    localStorage.setItem("ytt.resourcePreset", preset);
  } catch {
    // settings still apply for this session
  }
}
