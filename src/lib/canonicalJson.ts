/**
 * JSON with every object's keys in one fixed order, so equal values give
 * equal text and equal hashes. Keys are sorted by code unit, though
 * JavaScript writes integer-like keys first, in numeric order. Values are
 * otherwise written as `JSON.stringify` writes them: a value with a
 * `toJSON` (a date) as what that returns, -0 as 0, which it equals, and an
 * object's field set to undefined left out.
 *
 * It is made for JSON-like values: plain objects, lists, strings, finite
 * numbers, booleans and null, as stage inputs are. Of the values JSON would
 * blur into the text of another, it refuses the likely ones with a
 * TypeError: a Set, a Map, a boxed primitive or a class instance without
 * `toJSON` (written as `{}`), a number that is not finite or undefined in a
 * list (both written as `null`), a function, a symbol, a bigint, or nothing
 * at all. Rarer ones it does not catch: extra properties on a list, symbol
 * or non-enumerable keys, and an invalid date are written as JSON writes
 * them, and a cycle throws a RangeError.
 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, function (this: unknown, _key, field: unknown) {
    if (field === undefined && Array.isArray(this)) {
      throw new TypeError("canonicalJson cannot write undefined in a list exactly");
    }
    if (typeof field === "number" && !Number.isFinite(field)) {
      throw new TypeError(`canonicalJson cannot write ${field} exactly`);
    }
    if (typeof field === "function" || typeof field === "symbol") {
      throw new TypeError(`canonicalJson cannot write a ${typeof field}`);
    }
    if (typeof field !== "object" || field === null || Array.isArray(field)) return field;
    const prototype: unknown = Object.getPrototypeOf(field);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonicalJson writes only plain objects and arrays");
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(field).sort()) {
      // A plain assignment to "__proto__" would set the prototype instead.
      Object.defineProperty(sorted, key, {
        value: (field as Record<string, unknown>)[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return sorted;
  });
  if (text === undefined) throw new TypeError("canonicalJson has nothing to write");
  return text;
}
