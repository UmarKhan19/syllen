# AGENTS.md

## Running / testing the app

Never launch the app (or `npm run tauri dev`) on the real display. It steals focus,
creates windows on the user's desktop, and writes to their real library. Always run
it under Xvfb with isolated XDG dirs:

```sh
QC=/tmp/opencode/yt-qc
mkdir -p "$QC"/{data,config,cache}

Xvfb :99 -screen 0 1280x900x24 &
DISPLAY=:99 \
XDG_DATA_HOME="$QC/data" XDG_CONFIG_HOME="$QC/config" XDG_CACHE_HOME="$QC/cache" \
WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  npm run tauri dev
```

- Debug binary loads `devUrl` (localhost:1420), so either run `tauri dev` as above or
  build once with `npx tauri build --debug` and run `src-tauri/target/debug/yt-transcript`
  directly (then no vite needed).
- Screenshot: `DISPLAY=:99 import -window root /tmp/opencode/shot.png`
- Click/type: `DISPLAY=:99 xdotool ...`
- Cleanup when done: `pkill -f 'yt-transcript/node_modules/.bin/(tauri|vite)';
  pkill -f 'target/debug/yt-transcript'; pkill -f 'Xvfb :99'`

If `Xvfb` or `xdotool` is missing, ask the user to install
(`sudo pacman -S xorg-server-xvfb xdotool`). Do not fall back to the real display.

Xvfb has no GPU (software rendering) and no window manager, so GTK native dialogs
may map oddly. For quick CSS/layout checks, running only the frontend
(`npm run dev`) in a browser is fine; for anything touching the backend, use Xvfb.

Known Xvfb artifacts, not app bugs:

- Closing the window (`xdotool windowclose`) kills the process with a GDK
  `BadDrawable` X error, so Tauri's `RunEvent::Exit` cleanup never runs. Audio left
  in `jobs/` is expected; verify the startup sweep instead (restart the app).
- Save dialogs default to the process CWD because `downloadDir()` reads
  `~/.config/user-dirs.dirs`, which the isolated `XDG_CONFIG_HOME` does not have.
  The app's fallback path is working as designed.
