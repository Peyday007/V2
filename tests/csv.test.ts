import { describe, it, expect } from "vitest";
import { parseCsv, suggestMapping } from "../src/lib/csv";
import {
  normalizePhone,
  normalizeDomain,
  normalizeBusinessName,
  normalizeState,
} from "../src/lib/normalize";

describe("parseCsv", () => {
  it("parses a basic file", () => {
    const rows = parseCsv("a,b\n1,2\n3,4\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles quoted fields with commas", () => {
    const rows = parseCsv('name,city\n"Smith, Roofing Inc",Detroit\n');
    expect(rows[1][0]).toBe("Smith, Roofing Inc");
    expect(rows[1][1]).toBe("Detroit");
  });

  it("handles escaped quotes and CRLF", () => {
    const rows = parseCsv('name\r\n"Chuck""s Roofing"\r\n');
    expect(rows[1][0]).toBe('Chuck"s Roofing');
  });

  it("strips a BOM so the first header maps correctly", () => {
    const rows = parseCsv("﻿business_name,phone\nAcme,1\n");
    expect(rows[0][0]).toBe("business_name");
  });
});

describe("suggestMapping", () => {
  it("recognizes common header spellings", () => {
    const m = suggestMapping(["Company", "Phone Number", "Site", "Town", "Stars"]);
    expect(m["Company"]).toBe("business_name");
    expect(m["Phone Number"]).toBe("phone");
    expect(m["Site"]).toBe("website");
    expect(m["Town"]).toBe("city");
    expect(m["Stars"]).toBe("rating");
  });

  it("does not map the same field twice", () => {
    const m = suggestMapping(["name", "company"]);
    expect(Object.values(m).filter((v) => v === "business_name")).toHaveLength(1);
  });
});

describe("import normalization", () => {
  it("normalizes phones for duplicate detection", () => {
    expect(normalizePhone("(313) 386-8962")).toBe("3133868962");
    expect(normalizePhone("313.386.8962")).toBe("3133868962");
    expect(normalizePhone("+1 313 386 8962")).toBe("3133868962");
    expect(normalizePhone("123")).toBeNull();
  });

  it("normalizes domains for duplicate detection", () => {
    expect(normalizeDomain("https://www.chucksroofing.com/contact?utm_source=x")).toBe(
      "chucksroofing.com"
    );
    expect(normalizeDomain("chucksroofing.com")).toBe("chucksroofing.com");
    expect(normalizeDomain("not a domain")).toBeNull();
  });

  it("strips legal suffixes from names", () => {
    expect(normalizeBusinessName("Chuck's Roofing Company Inc")).toBe("chuck s roofing");
  });

  it("normalizes states", () => {
    expect(normalizeState("Michigan")).toBe("MI");
    expect(normalizeState("mi")).toBe("MI");
    expect(normalizeState("Narnia")).toBeNull();
  });
});
