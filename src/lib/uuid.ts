const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether text is a UUID; anything else names no row, and Postgres would refuse it as a uuid. */
export function isUuid(text: string): boolean {
  return UUID.test(text);
}
