/**
 * Every SQL statement names its schema through `{{schema}}` (platform spec
 * B1), filled in by the adapters. The name is checked once, here, so it can
 * be inserted into SQL text safely.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertSchemaName(name: string): void {
  if (!SCHEMA_NAME.test(name)) {
    throw new Error(
      `Invalid schema name ${JSON.stringify(name)}: use lower-case letters, digits and _`,
    );
  }
}

export function fillSchema(sql: string, schema: string): string {
  return sql.replaceAll("{{schema}}", schema);
}
