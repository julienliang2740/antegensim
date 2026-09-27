# Empyrean frontend

The operator console: Vite, React 19 and TypeScript (strict). It talks only to the backend's
`/api` routes (the dev server proxies `/api` to `EMPYREAN_API_PROXY`, default
`http://127.0.0.1:8000`). The backend does not serve the built files; use the dev server.

## Commands

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort    # the UI on http://127.0.0.1:5173
npx tsc -p tsconfig.app.json --noEmit                        # type check
npm run lint                                                 # oxlint (.oxlintrc.json)
node src/state/state.test.mjs                                # node:test over the pure state modules
npm run build                                                # tsc -b && vite build -> dist/ (one build at a time)
```

Open the UI via `localhost` or `127.0.0.1`: the browser allows the microphone for **Dictate**
only in a secure context.

## Layout

| Path | What |
| --- | --- |
| `src/App.tsx` | the route switch (`hooks/useHashRoute.ts`: `#/`, `#/new`, `#/resume`, `#/run/<id>`, `#/instructions`, `#/story`) plus the assistant drawer on every page |
| `src/pages/` | one component per route: entry, New session, Resume, the run page, How the world works, Story Mode |
| `src/components/run/` | run page parts: controls, status bar, timeline, activity log, record viewer, Turn record, God mode, Rules and Storybook tabs |
| `src/components/inspect/` | the 2D map (`MapView.tsx`; dot geometry, count badges and group tiles in `mapDots.ts`), inspectors, god-mode panel and forms, plant-rule and context editors |
| `src/components/map3d/` | the 3D view: `Map3dLoader.tsx` (the only part the run page renders: WebGL 2 check, error boundary, `React.lazy`), `MapViewSwitch.tsx`, `Map3dView.tsx`, the three.js scene (`scene.ts`), the label overlay, controls, tooltip and help card. The only folder that imports `three`; the build puts it in its own chunk, downloaded when **3D view** is chosen |
| `src/components/setup/` | New session form parts |
| `src/components/assistant/` | the assistant drawer: launcher, conversations, answers, brief cards, composer, Dictate, spend popover, Ask buttons |
| `src/components/story/` | Story Mode parts: run picker, run card, chips, interview, brief, reader |
| `src/api/` | `types.ts` (mirror of `backend/empyrean/schemas.py`), `client.ts` (core routes and the shared `request` helper), `assistant.ts` / `assistantTypes.ts`, `story.ts` / `storyTypes.ts`, `assistantSpeech.ts` (raw-audio upload) |
| `src/state/` | pure logic, no React: feed, status text, timeline, setup form, run sessions, assistant context store, answer formatting, brief rendering, Story Mode helpers, the viewed turn's effects (`turnEffects.ts`), the 2D action marks (`mapIndicators.ts`) and the 3D view's camera, layout, timeline, terrain, palette and glyphs (`map3d*.ts`, no three.js) |
| `src/hooks/` | data and layout hooks (`useRunFeed`, `useRunData`, `useRunLayout`, `useFetched`) |
| `src/dev/` | a dev-only inspect harness (`?harness=1`; `&view=3d` for the 3D view, `&layers=2` for two stacked layers) with fixtures |
| `src/*.css` | `index.css` (tokens, dark mode), `App.css` (layout, the **Map view** switch), `inspect.css` (the `--insp-*` map tokens and the 2D map), `map3d.css` (the 3D view, shipped in its chunk), `profile.css`, `setup.css`, `assistant.css`, `story.css`, `storybook.css`, `working.css` |

The full per-file map is `docs/CODE_MAP.md`; every control and its label is in
`docs/CONTROLS.md`.

## Conventions

* `verbatimModuleSyntax` (use `import type`), `erasableSyntaxOnly` (no `enum`, no parameter
  properties), `noUnusedLocals`.
* Every API call goes through `src/api/`; errors arrive as `ApiClientError` carrying the
  backend's `ApiError` body.
* Logic worth testing goes into `src/state/*.ts` (pure functions or an external store) and is
  registered in `src/state/state.test.mjs`.
* Colours come from the tokens in `src/index.css` (with dark-mode overrides); the map colours are the
  `--insp-*` tokens in `src/inspect.css`, which the 3D view reads at mount (so dark mode matches).
* `three` is imported only by `src/components/map3d/scene.ts`, `geometry.ts` and `labels.ts`, which only
  the lazily loaded `Map3dView.tsx` reaches, so a user who never opens the 3D view never downloads it.
* A changed label or control updates `docs/CONTROLS.md` (and the browser check locators in
  `qa/browser_check.mjs`) in the same commit; `scripts/check_docs.py` checks that every bold
  label in `docs/CONTROLS.md` appears in `src/`. See `CLAUDE.md`.
