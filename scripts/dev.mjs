import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = (script) => (npmCli ? [npmCli, "run", script] : ["run", script]);
const children = [
  spawn(npmCommand, npmArgs("dev:web"), { stdio: "inherit" }),
  spawn(npmCommand, npmArgs("dev:api"), { stdio: "inherit" }),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping && (code !== 0 || signal)) stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
