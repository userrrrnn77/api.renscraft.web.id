// src/utils/dynamicValidators.ts

export const BLOCKED_KEYS = new Set([
  "$",
  ".",
  "__proto__",
  "prototype",
  "constructor",
  "_id",
  "appId",
  "ownerId",
  "tenantId",
  "collectionId",
  "createdAt",
  "updatedAt",
  "schemaVersion",
]);

export const SYSTEM_SLUGS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "ai",
  "static",
  "assets",
  "mail",
  "ftp",
  "smtp",
]);

export function isValidFieldKey(key: string): boolean {
  if (typeof key !== "string") return false;
  if (/[$.]/.test(key)) return false;
  if (BLOCKED_KEYS.has(key)) return false;
  // Harus diawali huruf, alfanumerik/underscore, maks 40 char
  return /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key);
}

export function isValidSlug(slug: string): boolean {
  if (typeof slug !== "string") return false;
  if (SYSTEM_SLUGS.has(slug)) return false;
  // Lowercase, angka, strip, 3-40 char
  return (
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) &&
    slug.length >= 3 &&
    slug.length <= 40
  );
}

export const ALLOWED_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
  "select",
] as const;
export type FieldType = (typeof ALLOWED_FIELD_TYPES)[number];
