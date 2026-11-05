import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, "dist-site");
const publicDirectory = join(projectRoot, "public");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(publicDirectory, { recursive: true });

for (const directory of ["frontend", "admin", "shared"]) {
  await cp(join(projectRoot, directory), join(outputDirectory, directory), {
    recursive: true
  });
  await cp(join(projectRoot, directory), join(publicDirectory, directory), {
    recursive: true
  });
}
