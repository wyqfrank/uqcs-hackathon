import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import {
  repositoryRoot,
  virtualEnvironment,
  virtualEnvironmentPython,
} from "./python.mjs";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(virtualEnvironmentPython)) {
  const systemPython = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  run(systemPython, ["-m", "venv", virtualEnvironment]);
}

run(virtualEnvironmentPython, [
  "-m",
  "pip",
  "install",
  "-e",
  "services/inference[dev]",
]);
