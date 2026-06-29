import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "@app-shared";
import { client } from "./broker.js";
import { App } from "./App.js";
import "./styles.css";

// Kick off the connection to server-everything via the WS proxy.
void client.connect();

const root = document.getElementById("app")!;
createRoot(root).render(
  <StrictMode>
    <AppProvider client={client}>
      <App />
    </AppProvider>
  </StrictMode>,
);
