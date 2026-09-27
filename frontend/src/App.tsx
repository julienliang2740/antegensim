/**
 * Application shell: hash routes to the entry page, new session, resume
 * session, instructions, Story Mode and run pages (see hooks/useHashRoute.ts).
 * The run page is keyed by run id so switching runs starts from fresh state
 * (and closes the old run).
 *
 * The assistant drawer is rendered once, as a sibling after the page, so it
 * survives route changes (and RunPage remounts) with its conversation intact.
 * Pages talk to it through the external store in state/assistantContext.ts,
 * never through React context.
 */

import "./App.css";
import "./design.css";
import { AssistantDrawer } from "./components/assistant/AssistantDrawer";
import { useHashRoute, type Route } from "./hooks/useHashRoute";
import { EntryPage } from "./pages/EntryPage";
import { InstructionsPage } from "./pages/InstructionsPage";
import { NewSessionPage } from "./pages/NewSessionPage";
import { ResumePage } from "./pages/ResumePage";
import { RunPage } from "./pages/RunPage";
import { StoryPage } from "./pages/StoryPage";

function renderPage(route: Route) {
  switch (route.name) {
    case "new":
      return <NewSessionPage key={route.cloneRunId ?? "new"} cloneRunId={route.cloneRunId} />;
    case "resume":
      return <ResumePage />;
    case "run":
      return <RunPage key={route.runId} runId={route.runId} initialTurnId={route.turnId} />;
    case "instructions":
      return <InstructionsPage section={route.section} />;
    case "story":
      return <StoryPage route={route} />;
    case "entry":
      return <EntryPage />;
  }
}

export default function App() {
  const route = useHashRoute();
  return (
    <>
      {renderPage(route)}
      <AssistantDrawer route={route} />
    </>
  );
}
