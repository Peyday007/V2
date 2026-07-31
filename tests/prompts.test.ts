import { describe, it, expect } from "vitest";
import {
  PROMPTS,
  PROMPT_MAP,
  variablesUsed,
  validateTemplate,
  renderTemplate,
  resolvePrompt,
  sampleValues,
} from "../src/lib/prompts";

const CALL_TIP = PROMPT_MAP.call_tip;

describe("the shipped prompts are coherent", () => {
  it("every prompt has a unique key, a label and a default", () => {
    const keys = PROMPTS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PROMPTS) {
      expect(p.label.length, p.key).toBeGreaterThan(0);
      expect(p.default.trim().length, p.key).toBeGreaterThan(50);
      expect(p.usedFor.length, p.key).toBeGreaterThan(10);
    }
  });

  it("every default only uses variables it declares", () => {
    for (const p of PROMPTS) {
      const declared = new Set(p.variables.map((v) => v.name));
      for (const used of variablesUsed(p.default)) {
        expect(declared.has(used), `${p.key} uses undeclared {{${used}}}`).toBe(true);
      }
    }
  });

  it("every default passes its own validation — we do not ship a broken prompt", () => {
    for (const p of PROMPTS) {
      const errors = validateTemplate(p, p.default).filter((x) => x.level === "error");
      expect(errors, `${p.key}: ${errors.map((e) => e.message).join("; ")}`).toEqual([]);
    }
  });

  it("every important variable actually appears in its default", () => {
    for (const p of PROMPTS) {
      const used = new Set(variablesUsed(p.default));
      for (const v of p.variables.filter((x) => x.important)) {
        expect(used.has(v.name), `${p.key} default is missing {{${v.name}}}`).toBe(true);
      }
    }
  });
});

describe("variablesUsed", () => {
  it("finds each variable once, in order", () => {
    expect(variablesUsed("Hi {{a}}, see {{b}} and {{a}}")).toEqual(["a", "b"]);
  });
  it("tolerates spacing inside the braces", () => {
    expect(variablesUsed("{{ spaced }}")).toEqual(["spaced"]);
  });
  it("ignores single braces", () => {
    expect(variablesUsed("{not a var} {{real}}")).toEqual(["real"]);
  });
  it("returns nothing for plain text", () => {
    expect(variablesUsed("no variables here")).toEqual([]);
  });
});

describe("validation catches the mistakes a non-programmer makes", () => {
  it("rejects an empty prompt", () => {
    const errs = validateTemplate(CALL_TIP, "   ");
    expect(errs.some((e) => e.level === "error")).toBe(true);
  });

  it("rejects a misspelled variable, because it would be sent literally", () => {
    const errs = validateTemplate(CALL_TIP, "Give a tip for {{busines_name}} please, thank you");
    const err = errs.find((e) => e.level === "error");
    expect(err?.message).toContain("busines_name");
    expect(err?.message).toContain("sent to the model literally");
  });

  it("warns about single braces rather than blocking", () => {
    const problems = validateTemplate(
      CALL_TIP,
      "Give a practical tip for {business_name} in this call please"
    );
    const warn = problems.find((p) => p.message.includes("double braces"));
    expect(warn?.level).toBe("warning");
  });

  it("warns, but allows, dropping an important variable", () => {
    const problems = validateTemplate(CALL_TIP, "Give a short generic cold-calling tip.");
    expect(problems.some((p) => p.level === "error")).toBe(false);
    expect(problems.some((p) => p.level === "warning" && p.message.includes("business_name"))).toBe(
      true
    );
  });

  it("accepts a sensible rewrite", () => {
    const problems = validateTemplate(
      CALL_TIP,
      "In one sentence, how should we open the call to {{business_name}}, a {{industry}} business?"
    );
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes values", () => {
    expect(renderTemplate("Call {{name}} in {{city}}", { name: "Ace", city: "Troy" })).toBe(
      "Call Ace in Troy"
    );
  });
  it("repeats a variable used twice", () => {
    expect(renderTemplate("{{a}}-{{a}}", { a: "x" })).toBe("x-x");
  });
  it("renders a missing value as empty rather than leaving the braces", () => {
    expect(renderTemplate("Call {{name}}", {})).toBe("Call ");
    expect(renderTemplate("Call {{name}}", { name: null })).toBe("Call ");
  });
  it("handles numbers", () => {
    expect(renderTemplate("{{n}} reviews", { n: 84 })).toBe("84 reviews");
  });
});

describe("resolvePrompt never lets an edit take a feature offline", () => {
  it("uses the saved override when it is valid", () => {
    const r = resolvePrompt("call_tip", "Tip for {{business_name}} please, keep it short", {
      business_name: "Ace",
    });
    expect(r.usedDefault).toBe(false);
    expect(r.text).toContain("Ace");
  });

  it("falls back to the default when the override is broken", () => {
    const r = resolvePrompt("call_tip", "Tip for {{nonsense_variable}} thanks very much", {
      business_name: "Ace",
    });
    expect(r.usedDefault).toBe(true);
    expect(r.reason).toContain("default was used");
    expect(r.text).toContain("Ace");
  });

  it("uses the default when nothing is saved", () => {
    expect(resolvePrompt("call_tip", null, { business_name: "Ace" }).usedDefault).toBe(true);
    expect(resolvePrompt("call_tip", "   ", { business_name: "Ace" }).usedDefault).toBe(true);
  });

  it("never returns unsubstituted braces", () => {
    for (const p of PROMPTS) {
      const r = resolvePrompt(p.key, null, sampleValues(p));
      expect(r.text, p.key).not.toMatch(/\{\{/);
    }
  });

  it("degrades safely on an unknown key instead of throwing", () => {
    const r = resolvePrompt("no_such_prompt", "anything", {});
    expect(r.text).toBe("");
    expect(r.reason).toContain("Unknown prompt");
  });
});

describe("sampleValues", () => {
  it("gives every declared variable something to preview with", () => {
    for (const p of PROMPTS) {
      const s = sampleValues(p);
      for (const v of p.variables) {
        expect(s[v.name], `${p.key}.${v.name}`).toBeTruthy();
      }
    }
  });
});
