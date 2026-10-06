// Starts `next dev` for the end-to-end tests and copies everything it prints
// into .data/e2e/server.log, so the pairing test can check that no token ever
// reaches a server log line (platform spec B10, AC7).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const LOG_DIR = ".data/e2e";
mkdirSync(LOG_DIR, { recursive: true });
const log = createWriteStream(`${LOG_DIR}/server.log`);
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

const server = spawn(process.execPath, [nextBin, "dev", "-p", process.env.PORT ?? "3300"], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
}
server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
