# Relay teaser video

Remotion source for a ~28s silent social teaser (X / LinkedIn), reusing the exact color/type tokens from `docs/index.html` so the video and docs page read as one brand.

Not part of the published module — dev-only, like `test/` and `docs/` at the repo root.

## Structure

- `src/theme.ts` — shared color/font tokens and the 7-stage data, copied from `docs/index.html`'s CSS variables.
- `src/Fonts.tsx` — embeds Archivo / Source Serif / Plex Mono from `public/fonts/` and blocks each frame's render until they're actually loaded.
- `src/scenes/` — one component per beat: cold open, problem statement, transition line, the animated stage rail, a gate (FAIL → retry → PASS) moment, end card.
- `src/Teaser.tsx` — composes the scenes on a timeline via `<Sequence>`.
- `src/Root.tsx` / `src/index.ts` — registers the `Teaser` composition (1920x1080, 30fps, 840 frames).

## Commands

```bash
npm install
npm run dev              # Remotion Studio, scrub the timeline interactively
npm run still -- src/index.ts Teaser out/frame.png --frame=300   # one PNG at a given frame, fast sanity check
npm run build             # renders out/teaser.mp4
```

## Editing the beats

Scene timing lives in `src/Teaser.tsx`'s `SCENES` array (`from`/`duration` in frames at 30fps). Each scene component reads `useCurrentFrame()` relative to its own `<Sequence>`, so retiming one scene doesn't require touching the others' internal math except the `Rail` scene, which divides its own duration evenly across `STAGES.length`.
