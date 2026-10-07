// The parent process for test/e2e/orphan.test.ts: it starts a server with one
// of the three harnesses (argv: e2e | live | security, then the binary),
// prints {pid, dir} as one JSON line, and waits to be SIGKILLed. Plain
// JavaScript, so Node runs it without a build step; Node strips the types
// of the .ts harnesses it imports.

const [kind, bin] = process.argv.slice(2);
let server;
if (kind === "e2e") server = await (await import("./e2e-server.ts")).startServer(bin);
else if (kind === "live") server = await (await import("./live-server.ts")).startLiveServer();
else if (kind === "security")
  server = await (await import("./security-server.ts")).startSecurityServer(bin);
else throw new Error(`unknown harness ${kind}`);
process.stdout.write(`${JSON.stringify({ pid: server.pid, dir: server.dir })}\n`);
setInterval(() => {}, 60_000);
