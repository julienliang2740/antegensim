/**
 * Mount the inspect harness in place of the app.  Called from the guarded
 * line at the end of src/main.tsx when the URL contains `harness=1`; replaces
 * #root with a fresh container so the app's own root is detached from the page.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InspectHarness } from "./InspectHarness";

export function mountHarness(): void {
  const old = document.getElementById("root");
  const container = document.createElement("div");
  container.id = "harness-root";
  if (old) old.replaceWith(container);
  else document.body.appendChild(container);
  document.title = "Inspect harness";
  createRoot(container).render(
    <StrictMode>
      <InspectHarness />
    </StrictMode>,
  );
}
