import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthGate } from "./components/auth-gate";

document.title = "Fallback Forge";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthGate>{(signOut) => <App onSignOut={signOut} />}</AuthGate>
  </React.StrictMode>,
);
