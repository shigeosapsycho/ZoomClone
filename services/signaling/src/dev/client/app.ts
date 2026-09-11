// Placeholder entry point for the /dev gallery harness (Plan 4, Task 0: protocol addition,
// client build pipeline and /dev/ serving). This file gives buildHarness something real to
// bundle: an ESM entry that imports its stylesheet (exercising esbuild's CSS code splitting)
// and reads the api base the server injects into the page shell via window.__config. Task 3
// replaces this placeholder with the actual gallery client: mediasoup-client transports, the
// tally bar, stage, rack, control strip and tape described in the MVP design doc, wired to the
// protocol this harness proves it can ship to a browser.
import "./styles.css";

const config = (window as unknown as { __config: { apiBase: string } }).__config;
document.getElementById("app")!.textContent = `gallery client placeholder (api ${config.apiBase})`;
