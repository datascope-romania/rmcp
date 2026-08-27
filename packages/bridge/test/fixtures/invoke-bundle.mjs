import { handler } from "../../dist/index.mjs";

const res = await handler(JSON.parse(process.argv[2]));
console.log(JSON.stringify(res));
process.exit(0); // the spawned MCP child would otherwise keep the event loop alive
