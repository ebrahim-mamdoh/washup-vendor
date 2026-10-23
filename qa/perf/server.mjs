/**
 * Single-process production server for profiling (clinic doctor/flame, or node --cpu-prof).
 * `next start` may run the app in a child process, which clinic can't see; this
 * runs Next's request handler in the profiled process itself.
 *
 *   PORT=3302 node qa/perf/server.mjs            (after `npm run build`)
 *   PORT=3302 EXIT_AFTER_MS=40000 node --cpu-prof --cpu-prof-dir=qa/perf/results qa/perf/server.mjs
 *   (EXIT_AFTER_MS exits cleanly so V8 writes the .cpuprofile)
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.PORT ?? 3302);
const app = next({ dev: false, dir, port });
await app.prepare();
const handle = app.getRequestHandler();
http.createServer((req, res) => handle(req, res)).listen(port, () => console.log(`profiling server on :${port}`));
if (process.env.EXIT_AFTER_MS) setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER_MS));
