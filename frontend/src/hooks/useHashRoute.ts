/**
 * Minimal hash router (no library): "#/" entry, "#/new" new session,
 * "#/resume" saved sessions, "#/run/<run_id>" a run, optionally
 * "#/run/<run_id>?turn=<turn_id>" to open it on a recorded turn.
 */

import { useEffect, useState } from "react";

export type Route = { name: "entry" } | { name: "new" } | { name: "resume" } | { name: "run"; runId: string; turnId: string | null };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  if (parts[0] === "new") return { name: "new" };
  if (parts[0] === "resume") return { name: "resume" };
  if (parts[0] === "run" && parts[1]) {
    const query = new URLSearchParams(queryPart ?? "");
    return { name: "run", runId: decodeURIComponent(parts[1]), turnId: query.get("turn") };
  }
  return { name: "entry" };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "entry":
      return "#/";
    case "new":
      return "#/new";
    case "resume":
      return "#/resume";
    case "run":
      return `#/run/${encodeURIComponent(route.runId)}${route.turnId ? `?turn=${encodeURIComponent(route.turnId)}` : ""}`;
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
