import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { SessionGate } from "./people/SessionGate.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./people/SignIn.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionGate>
      <App />
    </SessionGate>
  </StrictMode>,
);
