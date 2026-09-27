/**
 * Minimal hash router (no library):
 *   "#/"                              entry
 *   "#/new"                           new session; "?clone=<run_id>" prefills its original setup
 *   "#/resume"                        saved sessions
 *   "#/run/<run_id>"                  a run, optionally "?turn=<turn_id>" to open it on a recorded turn
 *   "#/instructions"                  "How the world works", optionally "?section=<id>" to open at a section
 *   "#/story"                         Story Mode: choose a run
 *   "#/story/<run_id>"                Story Mode for one run (interview / story list)
 *   "#/story/<run_id>/<story_id>"     one story of that run (brief, reader)
 *
 * parseHash and routeHash are pure and round-trip (state.test.mjs).
 */

import { useEffect, useState } from "react";

export type Route =
  | { name: "entry" }
  | { name: "new"; cloneRunId?: string }
  | { name: "resume" }
  | { name: "run"; runId: string; turnId: string | null }
  | { name: "instructions"; section: string | null }
  | { name: "story"; runId: string | null; storyId: string | null };

/** The Story Mode route (StoryPage's prop). storyId is only ever set together with runId. */
export type StoryRoute = Extract<Route, { name: "story" }>;
/** The instructions route (InstructionsPage's section deep link). */
export type InstructionsRoute = Extract<Route, { name: "instructions" }>;

function decodePart(part: string | undefined): string | null {
  if (!part) return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart ?? "");
  if (parts[0] === "new") return query.get("clone") ? { name: "new", cloneRunId: query.get("clone")! } : { name: "new" };
  if (parts[0] === "resume") return { name: "resume" };
  if (parts[0] === "run" && parts[1]) {
    return { name: "run", runId: decodePart(parts[1]) ?? parts[1], turnId: query.get("turn") };
  }
  if (parts[0] === "instructions") return { name: "instructions", section: query.get("section") || null };
  if (parts[0] === "story") {
    const runId = decodePart(parts[1]);
    return { name: "story", runId, storyId: runId ? decodePart(parts[2]) : null };
  }
  return { name: "entry" };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "entry":
      return "#/";
    case "new":
      return `#/new${route.cloneRunId ? `?clone=${encodeURIComponent(route.cloneRunId)}` : ""}`;
    case "resume":
      return "#/resume";
    case "run":
      return `#/run/${encodeURIComponent(route.runId)}${route.turnId ? `?turn=${encodeURIComponent(route.turnId)}` : ""}`;
    case "instructions":
      return `#/instructions${route.section ? `?section=${encodeURIComponent(route.section)}` : ""}`;
    case "story": {
      if (!route.runId) return "#/story";
      const run = `#/story/${encodeURIComponent(route.runId)}`;
      return route.storyId ? `${run}/${encodeURIComponent(route.storyId)}` : run;
    }
  }
}

export function navigate(route: Route): void {
  const hash = routeHash(route);
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
