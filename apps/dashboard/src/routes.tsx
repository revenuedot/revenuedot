import { Route } from "react-router-dom";
import { Overview } from "./pages/Overview";

/** Project routes. URL paths mirror RevenueCat's dashboard so bookmarks and muscle memory carry over. */
export const routes = [
  <Route key="overview" path="/projects/:projectId/overview" element={<Overview />} />,
];
