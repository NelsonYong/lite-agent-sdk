import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSafePath } from "./tools/file";

/** Anchor a runtime directory once; reject root replacement and symlink records. */
export function storageDirectory(dir: string): (path?: string) => string {
  const directory = resolve(dir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = lstatSync(directory);
  if (identity.isSymbolicLink()) throw new Error("Storage directory must not be a symlink");
  const root = realpathSync(directory);
  return (path = ".") => {
    const current = lstatSync(directory);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(directory) !== root)
      throw new Error("Storage directory changed");
    return resolveSafePath(root, path, { mode: "read", symlinks: "deny" });
  };
}
