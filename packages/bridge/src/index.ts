import { createBackend } from "./backends.js";
import { loadRuntime } from "./config.js";
import { makeHandler } from "./handler.js";

export const handler = makeHandler(loadRuntime, createBackend);

export { createBackend } from "./backends.js";
export { loadRuntime, resetRuntimeCache, type Runtime } from "./config.js";
export { makeHandler } from "./handler.js";
export type { Backend, FnUrlEvent, FnUrlResponse } from "./types.js";
