# DESIGN

YT Transcript's visual world: a document surface for spoken words.

## World statement

A transcript is a document, so the app is a document surface — one paper ground,
black ink, hairline rules, and colour reserved for the people speaking. Chrome
is a newsprint grotesk; spoken words are set in a book serif; timecodes are set
in mono. No decorative accent, no gradients, no glass, no cards: rules and
margins do the separating.

## Palette (tokens in `src/styles.css`)

### Grounds

| Token | Value | Use |
|---|---|---|
| `--paper` | `#f1f1ee` | Page ground (body background) |
| `--sheet` | `#fafaf8` | Raised surfaces: controls only (URL field, toolbar, ghost buttons) |
| `--wash` | `#f6f6f2` | Faint field behind code snippets in callouts |

### Ink

| Token | Value | Use |
|---|---|---|
| `--ink` | `#14161a` | Primary text, headings, action fill, deep controls |
| `--ink-2` | `#4a4f57` | Secondary text |
| `--ink-3` | `#676c74` | Meta text, timecodes, labels |
| `--speech` | `#1c1f25` | Spoken-word body text |

### Rules

| Token | Value | Use |
|---|---|---|
| `--rule` | `#dedcd7` | Hairline separation (transcript margin rule, process-table columns) |
| `--rule-soft` | `#e8e6e1` | Softer separation (process-table verticals on narrow viewports) |

### Speaker pens (colour means something — only meaning)

| Token | Value | Use |
|---|---|---|
| `--pen-1` | `#2f4d8c` | Speaker 1 |
| `--pen-2` | `#99401f` | Speaker 2 |
| `--pen-3` | `#1c6153` | Speaker 3 |
| `--pen-4` | `#6a3467` | Speaker 4 |

### Status

| Token | Value | Use |
|---|---|---|
| `--alert` | `#9c2f21` | Failure states |
| `--alert-wash` | `#f7ecea` | Failure callout ground |
| `--ok` | `#2a6540` | Success states |

### Reading states

Neutral washes, never accent colours: the current passage sits on `--read`,
the spoken word on `--word`, and a hovered word on `--word-hover`. The
unplayed waveform is `--wave`, a darker rule.

| Token | Value | Use |
|---|---|---|
| `--read` | `rgba(20, 22, 26, 0.045)` | Current passage |
| `--word-hover` | `rgba(20, 22, 26, 0.075)` | Word under the pointer |
| `--word` | `rgba(20, 22, 26, 0.14)` | Word being spoken |
| `--wave` | `#c9c6bf` | Unplayed waveform bars |

## Typography

| Role | Face | Stack token | Notes |
|---|---|---|---|
| Chrome / display | Schibsted Grotesk | `--font-ui` | Self-hosted latin subset (OFL 1.1) |
| Spoken words | Source Serif 4 | `--font-text` | Self-hosted latin subset (OFL 1.1) |
| Measurement / timecodes | Spline Sans Mono | `--font-mono` | Self-hosted latin subset (OFL 1.1) |

All three families are self-hosted under `public/fonts/`; the SIL OFL licence
text ships beside each font file.

## Scale

- Window bar: 58px
- Display headline: 34px, weight 600, tracking −0.022em
- URL field / primary action: 54px
- Body copy: 15px / 1.5
- Spoken-word transcript: 17px / 1.72, 68ch measure, `text-wrap: pretty`
- Meta text: 12.5px, 1.55–1.6
- Smallprint: 12px

## Geometry

- Card radii: 12px (`--radius`), small controls: 9px (`--radius-sm`)
- Sticky chrome: 58px topbar, 58px player directly below it; transcript paragraphs carry `scroll-margin-top: 128px` so a followed passage never hides under them
- Transcript paragraph: ruled left margin, 58px timecode column, 96px speaker column, speech column at 68ch with 20px stand-off from the margin rule
- Continuation ticks: hairline between turn-continue paragraphs
- Shadow: single soft float shadow on the settings drawer only (`--shadow-float`); no drop shadows elsewhere

## Colour discipline

Colour carries meaning only: the four speaker pens, the green privacy pip, the
red of a failure. No decorative accent appears anywhere. Amber is not used.

## Motion

Two authored moments only:
- Settings drawer slide-in (`slideIn`, 0.22s)
- Progress rail fill (exponential ease-out, `cubic-bezier(0.22, 0.61, 0.36, 1)`)

Follow-scrolling uses the browser's smooth scroll and falls back to an instant
jump under `prefers-reduced-motion`. Highlight changes are instant: the
reading position must not lag the audio.

Overlay fade-in and toast rise are state transitions, not decoration. Respects
`prefers-reduced-motion`.

## Components (see `src/styles.css`)

- **topbar** — 58px window bar: wordmark left, "Audio never leaves this machine" + green pip, settings right.
- **composer** — URL field with chain glyph, ink-filled primary action on the idle screen.
- **pipeline** — Four named stages with ink-filled done markers, mono percent, ink fill rail.
- **transcript** — Ruled left margin, timecode + speaker name in margin, speech set beside.
- **player** — Sticky under the topbar: ink play button, mono clock, waveform seek bar with a hover time tag, and a quiet Follow toggle. No card, no shadow; a bottom hairline separates it from the text.
- **specimen** — Idle-screen teaching surface using the transcript's own grid and inks.
- **drawer** — Settings: speaker-labeling switch, yt-dlp version chip, update button, log.
- **callout / alert** — Hairline-bordered surfaces; alert carries red text and a recovery line.

## What this replaces

The prior dark-slate (`#0c0e12`) / amber (`#e6a23c`) dashboard world. That look
was treated as evidence of the subject, not authority; it is not referenced in
this file.

## Provenance

Fonts fetched from Google Fonts (SIL Open Font License 1.1), latin subsets,
self-hosted at `public/fonts/`. Licence texts committed beside each `.woff2`.
Desert Ant Labs attribution ("Powered by Desert Ant Labs Voz and Who.") is
required by the model licence and remains in the footer.
