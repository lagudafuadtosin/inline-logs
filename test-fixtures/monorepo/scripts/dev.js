// Starts every package's "start" script at the same time, each in its own
// folder, the way Turborepo runs a task across a workspace.
const { spawn } = require("node:child_process");
const path = require("node:path");

for (const name of ["api", "web"]) {
  const cwd = path.join(__dirname, "..", "packages", name);
  spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "start"], { cwd, stdio: "inherit", shell: process.platform === "win32" });
}
