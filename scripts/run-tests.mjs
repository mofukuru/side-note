// Runs the compiled test files with Node's built-in test runner.
//
// The npm script used to rely on a `**/*.test.js` glob, which the shell does not expand on
// Windows and which Node's test runner only accepts from v21. Collecting the files here keeps
// `npm test` working identically on Node 20 (used by CI) and on newer versions.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = ".test-dist/tests";
const files = [];

(function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".test.js")) files.push(path);
    }
})(root);

if (!files.length) {
    console.error(`No test files found under ${root}. Run "tsc -p tsconfig.test.json" first.`);
    process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
