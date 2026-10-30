# Surface brief — Syllen (app shell)

## Scope and mode

- **Surface:** the single app window (Tauri webview, 1040×780 default, 720 px
  minimum width). One screen with four states: idle, working, result, settings
  drawer.
- **Mode:** Operate. The visitor is a person transcribing a video; the job is
  paste a link, watch the job, read the transcript, export it.

## Audience, job, action

- Audience: people who need the words of a long spoken-word video — journalists,
  students, podcast producers.
- Job: get a speaker-labelled transcript with timestamps without sending audio
  to a service.
- Action: paste a YouTube URL and press Transcribe. Secondary actions: copy,
  export SRT/VTT/TXT, toggle speaker labelling, update yt-dlp.
- Constraints: the app runs locally and offline after the first model download;
  jobs take minutes; the transcript is read for long stretches.

## Chosen direction

**The script room.** A modern print-shop for spoken words: paper, black ink,
four coloured pencils for the voices in the room, and a ruled margin holding
the timecodes. The transcript is treated as a *document* (the thing the
product makes), not as a panel in a dashboard.

Derived from the audience's own world — broadcast subtitling and cue sheets,
script and screenplay conventions, court and deposition transcripts, podcast
edit timelines, academic marginalia, field notebooks. The ruling world of the
broadcast transcript won because the product's unit of output is literally a
transcript page.

Rejects the incumbent dark-slate/amber dashboard (evidence of the subject, not
authority) and the category default of a dark utility with one neon accent.
Colour carries meaning only: the four speaker inks, the green privacy pip, the
red of a failure. Everything else is ink on paper.

## Memorable moment

The transcript page: a ruled left margin holding the timecodes and the speaker
names, set the way a script or a caption cue sheet is set, with a hairline tick
marking a paragraph that continues the same speaker. The name appears once per
turn, so a two-hour interview reads as speech, not as a spreadsheet.

## Unresolved decisions

- The idle page carries a labelled "Example output" specimen and a four-column
  process table. Both are honest (labelled / factual) but they are the parts a
  future session may want to re-cut.
- No dark theme. The world is committed to one ground.

## Direction contract

**THESIS:** A transcript is a document, so the app is a document surface: one
ground of paper, black ink, ruled margins, and colour reserved for the people
speaking. It refuses the category arrangement of a dark utility dashboard
whose chrome competes with its output.

**OWN-WORLD:** Paper `#f1f1ee`, ink `#14161a`, four speaker inks (indigo
`#2f4d8c`, clay `#99401f`, pine `#1c6153`, plum `#6a3467`), hairline rules
`#dedcd7`, raised surfaces `#fafaf8` used only for controls. Chrome in
Schibsted Grotesk, spoken words in Source Serif 4, timecodes in Spline Sans
Mono. No decorative accent, no gradients, no glass, no cards: rules and
margins do the separating.

**STORY:** The visitor pastes a link, watches four named stages run on their
own machine, and reads a labelled transcript they can copy or export. The
window teaches the format before it is asked to produce it.

**FIRST VIEWPORT:** A 58 px window bar (wordmark left, "Audio never leaves
this machine" with a green pip, settings right). Below, on paper: the
statement "Transcribe a video." at 34 px, a one-line lede, a 54 px URL field
with an ink-filled "Transcribe" button, a two-line fact note, a hairline-ruled
four-column process table (Download / Prepare / Transcribe / Speakers, each
with one plain sentence), and a labelled "Example output" specimen of three
rows set in the transcript's own grid and the transcript's own speaker inks, so
what the window teaches is exactly what it ships. Footer anchored at the
bottom with the Desert Ant Labs attribution.

**FORM:** Chosen from the derived list by hand — the broadcast-transcript /
script-page world, position 1 of 7 on resonance. No concept roll was
available in this installation (the bundled `impeccable` launcher, v0.1.5,
exposes only `detect`, `ignores`, `help`, `install`, `link`, `update`,
`check`; there is no `concept-seed`), so no seed key exists to record. The
derivation followed the documented method: the mechanism, the scene, the
audience's own artefacts, and the category rut and its opposite, with the
chosen world selected on resonance and product clarity rather than on taste.

**FINISH:** "unreviewed and undocumented is unfinished; this build ends with
the finish review, the verdict, DESIGN.md, and every shipping raster carrying
its provenance".
