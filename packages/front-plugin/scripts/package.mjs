// Assembles the uploadable Front plugin: page + styles + the built script.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "assets", "main.js"));

const name = "overturn-front-plugin.zip";
const dest = path.join(root, "dist", name);
rmSync(dest, { force: true });
try {
  execFileSync("zip", ["-qr", dest, "."], { cwd: out });
} catch {
  // The reference Zendesk packager shells out to `zip`; this fallback keeps the
  // same artifact on hosts that only have Python.
  execFileSync("python3", [
    "-c",
    "import sys, zipfile, pathlib\n" +
      "dest, root = sys.argv[1], pathlib.Path(sys.argv[2])\n" +
      "with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:\n" +
      "    for p in root.rglob('*'):\n" +
      "        if p.is_file():\n" +
      "            z.write(p, p.relative_to(root).as_posix())\n",
    dest,
    out,
  ]);
}
console.log(`dist/${name}`);
