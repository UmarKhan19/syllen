export const MEDIA_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "mpg",
  "mpeg",
  "wmv",
  "flv",
  "ts",
  "m2ts",
  "3gp",
  "3g2",
  "ogv",
  "mp3",
  "m4a",
  "m4b",
  "wav",
  "flac",
  "ogg",
  "oga",
  "opus",
  "aac",
  "wma",
  "aiff",
  "aif",
  "amr",
  "au",
  "caf",
  "ac3",
];

export function isMediaArtifactPath(file) {
  const lower = file.toLowerCase();
  const typescriptSource =
    lower.endsWith(".ts") && (/^(src|scripts)\//.test(lower) || lower === "vite.config.ts");
  return !typescriptSource && MEDIA_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`));
}
