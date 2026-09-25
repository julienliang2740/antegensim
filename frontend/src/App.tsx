/**
 * Application shell: hash routes to the entry page, new session, resume
 * session and run pages (see hooks/useHashRoute.ts).  The run page is keyed
 * by run id so switching runs starts from fresh state (and closes the old run).
 */

import "./App.css";
import { useHashRoute } from "./hooks/useHashRoute";
import { EntryPage } from "./pages/EntryPage";
import { NewSessionPage } from "./pages/NewSessionPage";
import { ResumePage } from "./pages/ResumePage";
import { RunPage } from "./pages/RunPage";

export default function App() {
  const route = useHashRoute();
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
