// --import entry point for the server child process: installs the
// mongodb -> stub resolution hook before src/main.js is loaded.
import { register } from "node:module";

register("./mongo-hooks.mjs", import.meta.url);
