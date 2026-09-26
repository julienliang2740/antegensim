/**
 * Application shell: hash routes to the entry page, new session, resume
 * session, instructions and run pages (see hooks/useHashRoute.ts; the
 * instructions page "#/instructions" is matched here, before the router,
 * which re-renders on every hash change).  The run page is keyed
 * by run id so switching runs starts from fresh state (and closes the old run).
 */

import "./App.css";
import { useHashRoute } from "./hooks/useHashRoute";
import { EntryPage } from "./pages/EntryPage";
import { InstructionsPage, isInstructionsHash } from "./pages/InstructionsPage";
import { NewSessionPage } from "./pages/NewSessionPage";
import { ResumePage } from "./pages/ResumePage";
import { RunPage } from "./pages/RunPage";

export default function App() {
  const route = useHashRoute();
  if (route.name === "entry" && isInstructionsHash(window.location.hash)) return <InstructionsPage />;
  switch (route.name) {
    case "new":
      return <NewSessionPage />;
    case "resume":
      return <ResumePage />;
    case "run":
      return <RunPage key={route.runId} runId={route.runId} initialTurnId={route.turnId} />;
    case "entry":
      return <EntryPage />;
  }
}
