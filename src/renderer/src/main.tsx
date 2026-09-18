import React from "react";
import ReactDOM from "react-dom/client";
import { WebApp } from "./web/WebApp";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);
