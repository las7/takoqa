/** Loads and validates a product profile from YAML. */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { ProfileSchema, type Profile } from "./types.js";

export interface LoadedProfile {
  profile: Profile;
  /** Directory of the profile file, used to resolve relative fixture paths. */
  baseDir: string;
}

export function loadProfile(path: string): LoadedProfile {
  const raw = readFileSync(path, "utf8");
  const data = parse(raw);
  let profile: Profile;
  try {
    profile = ProfileSchema.parse(data);
  } catch (err) {
    // The schema is .strict(): a typo'd or vestigial key (e.g. a removed
    // report:/fix: block) fails loudly here. Surface a readable message naming
    // the offending key/path instead of dumping the raw ZodError.
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n  ");
      throw new Error(`Invalid profile "${path}":\n  ${issues}`);
    }
    throw err;
  }
  return { profile, baseDir: dirname(resolve(path)) };
}

/** Resolves a fixture name against the profile directory unless absolute. */
export function makeFixtureResolver(baseDir: string) {
  return (name: string): string =>
    isAbsolute(name) ? name : resolve(baseDir, name);
}
