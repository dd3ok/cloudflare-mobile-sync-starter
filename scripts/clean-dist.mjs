import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const packageDirectory = resolve(process.cwd());
const target = resolve(packageDirectory, "dist");

if (basename(target) !== "dist" || dirname(target) !== packageDirectory) {
  throw new Error("Refusing to clean a path outside the current package");
}

await rm(target, { force: true, recursive: true });
