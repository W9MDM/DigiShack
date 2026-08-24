import { z } from "zod";

/**
 * A boolean query parameter.
 *
 * NEVER use `z.coerce.boolean()` for query strings. It applies JavaScript's
 * `Boolean()` semantics, under which every non-empty string is true — so
 * `?dryRun=0` and `?dryRun=false` both mean TRUE, and the only way to express
 * false is to omit the parameter. That silently inverted a destructive flag:
 * `?dryRun=0` on the QRZ import was read as "dry run", so a real import imported
 * nothing and reported success.
 *
 * This accepts the spellings people actually send, and rejects anything else
 * rather than guessing.
 */
export function boolQuery(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return defaultValue;
      if (typeof v === "boolean") return v;

      switch (v.trim().toLowerCase()) {
        case "1":
        case "true":
        case "yes":
        case "on":
          return true;
        case "0":
        case "false":
        case "no":
        case "off":
          return false;
        default:
          ctx.addIssue({
            code: "custom",
            message: `Expected a boolean (1/0, true/false, yes/no), got "${v}"`,
          });
          return defaultValue;
      }
    });
}
