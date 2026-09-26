// Render the deterministic "What will happen" lines of brief cards with the REAL frontend
// function (frontend/src/state/assistantBrief.ts describeAction / approveLabel), so the
// playtest can check that the typed action the backend stored renders as the UI would show it.
//
// Usage (from the repo root):  node qa/render_brief.mjs < briefs.json > rendered.json
// stdin: JSON array of {"action": <typed BriefAction dict or null>, "run_names": {id: name}}
// stdout: JSON array of {"lines": [...], "approve_label": "..."}
//
// Transpiles the TypeScript modules with the compiler installed under frontend/node_modules,
// exactly like frontend/src/state/state.test.mjs does (types erased, nothing type-checked).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "..", "frontend");
const SRC = path.join(FRONTEND, "src");
const OUT = path.join(FRONTEND, "node_modules", ".cache", "empyrean-render-brief");
const require = createRequire(path.join(FRONTEND, "package.json"));
const ts = require("typescript");

const MODULES = ["api/types.ts", "api/assistantTypes.ts", "state/assistantContext.ts", "components/inspect/format.ts", "components/inspect/logic.ts", "state/assistantBrief.ts"];

fs.rmSync(OUT, { recursive: true, force: true });
for (const rel of MODULES) {
  const source = fs.readFileSync(path.join(SRC, rel), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    fileName: rel,
  });
  const fixed = outputText.replace(/from "(\.{1,2}\/[^"]+?)(\.tsx?)?"/g, (_m, spec) => `from "${spec}.mjs"`);
  const target = path.join(OUT, rel.replace(/\.tsx?$/, ".mjs"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fixed);
}

const brief = await import(pathToFileURL(path.join(OUT, "state/assistantBrief.mjs")).href);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const out = input.map((item) => {
  const action = item.action ?? null;
  const options = { runNames: item.run_names ?? {}, onScreenRunId: item.on_screen_run_id ?? null, runState: item.run_state ?? null };
  try {
    return { lines: brief.describeAction(action, options), approve_label: brief.approveLabel(action) };
  } catch (err) {
    return { lines: [], approve_label: "", error: String(err && err.message ? err.message : err) };
  }
});
process.stdout.write(JSON.stringify(out));
