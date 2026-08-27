import type { Runtime } from "./config.js";
import { createHttpProxyBackend } from "./httpProxy.js";
import { createStdioBackend } from "./stdio.js";
import type { Backend } from "./types.js";

export function createBackend(rt: Runtime): Backend {
  switch (rt.config.mode) {
    case "stdio": return createStdioBackend(rt);
    case "http-proxy": return createHttpProxyBackend(rt);
  }
}
