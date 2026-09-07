import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { validateRegistry } from "./semantic.js";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (ajv: Ajv2020) => void;
const schema = JSON.parse(await readFile(resolve(root, "schema/metadata.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
for (const network of ["preview", "preprod", "stagenet"]) {
  const path = resolve(root, `metadata/metadata.${network}.json`);
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!validate(value)) throw new Error(`${path}: ${ajv.errorsText(validate.errors)}`);
  const semantic = validateRegistry(value, network as "preview" | "preprod" | "stagenet");
  if (!semantic.ok) throw new Error(`${path}: ${semantic.errors.join("; ")}`);
}
console.log("Validated public metadata files");
