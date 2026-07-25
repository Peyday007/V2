// Minimal RFC-4180-ish CSV parser: quoted fields, embedded commas/newlines, CRLF.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export const IMPORTABLE_FIELDS = [
  "business_name",
  "phone",
  "website",
  "address",
  "city",
  "state",
  "zip",
  "industry",
  "rating",
  "review_count",
  "source",
  "source_id",
] as const;

export type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

const HEADER_ALIASES: Record<ImportableField, string[]> = {
  business_name: ["business_name", "name", "company", "company_name", "business"],
  phone: ["phone", "phone_number", "primary_phone", "telephone"],
  website: ["website", "url", "site", "domain", "web_site"],
  address: ["address", "street", "street_address", "address1", "full_address"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "zip_code", "postal_code"],
  industry: ["industry", "category", "type", "vertical", "keyword"],
  rating: ["rating", "stars", "google_rating"],
  review_count: ["review_count", "reviews", "num_reviews", "user_ratings_total"],
  source: ["source", "lead_source"],
  source_id: ["source_id", "place_id", "external_id", "google_place_id"],
};

export function suggestMapping(headers: string[]): Record<string, ImportableField> {
  const suggested: Record<string, ImportableField> = {};
  const taken = new Set<string>();
  for (const header of headers) {
    const key = header.trim().toLowerCase().replace(/\s+/g, "_");
    for (const field of IMPORTABLE_FIELDS) {
      if (!taken.has(field) && HEADER_ALIASES[field].includes(key)) {
        suggested[header] = field;
        taken.add(field);
        break;
      }
    }
  }
  return suggested;
}
