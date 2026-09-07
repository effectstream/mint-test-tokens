import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "../../..");
const schema = JSON.parse(await readFile(resolve(root, "schema/metadata.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
for (const network of ["preview", "preprod", "stagenet"]) {
  const path = resolve(root, `metadata/metadata.${network}.json`);
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!validate(value)) throw new Error(`${path}: ${ajv.errorsText(validate.errors)}`);
}
console.log("Validated public metadata files");
