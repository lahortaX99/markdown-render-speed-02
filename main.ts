import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

// Driver: render every case in order; output is deterministic.
// (Attempt 8: parse.js carries the speed work — jump-scan autolinks,
// defs-pass trims, hasDelim skip, escapeHtml fast path.)
const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const cases = JSON.parse(readFileSync(join(inDir, "cases.json"), "utf8"));
const html = [];
for (let i = 0; i < cases.length; i++) html.push(parse(cases[i].markdown));
writeFileSync(join(outDir, "html.json"), JSON.stringify(html));
// attempt 8 final: single-pass deferred inline rendering, 720/720, ~1.5x
