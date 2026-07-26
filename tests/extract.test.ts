import { describe, it, expect } from "vitest";
import {
  extractPeople,
  discoverPeoplePages,
  stripHtml,
} from "../src/lib/extractPeople";
import { isAllowedByRobots } from "../src/lib/crawler.robots";

describe("extracting decision-makers from a page", () => {
  it("reads schema.org founder data", () => {
    const html = `<script type="application/ld+json">
      {"@type":"LocalBusiness","name":"Turner Plumbing",
       "founder":{"@type":"Person","name":"Michael Turner","jobTitle":"Owner"}}
    </script>`;
    const [p] = extractPeople(html, "Turner Plumbing");
    expect(p.name).toBe("Michael Turner");
    expect(p.title).toBe("Owner");
    expect(p.method).toBe("json_ld");
    expect(p.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("reads 'Name, Title' on a team page", () => {
    const html = `<div class="team"><h3>Sarah Johnson, Office Manager</h3></div>`;
    const [p] = extractPeople(html, "Acme HVAC");
    expect(p.name).toBe("Sarah Johnson");
    expect(p.title.toLowerCase()).toContain("office manager");
  });

  it("reads 'Title: Name'", () => {
    const html = `<p>Owner: Dave Brennan</p>`;
    const [p] = extractPeople(html, "Brennan Roofing");
    expect(p.name).toBe("Dave Brennan");
    expect(p.title.toLowerCase()).toBe("owner");
  });

  it("reads narrative founder statements", () => {
    const html = `<p>Founded in 1998 by Robert Alvarez, we have served the area…</p>`;
    const [p] = extractPeople(html, "Alvarez Electric");
    expect(p.name).toBe("Robert Alvarez");
    expect(p.title).toBe("Founder");
  });

  it("reads 'owned and operated by'", () => {
    const html = `<p>Proudly owned and operated by Karen Wallace since 2004.</p>`;
    const [p] = extractPeople(html, "Wallace Pest");
    expect(p.name).toBe("Karen Wallace");
    expect(p.title).toBe("Owner");
  });

  it("boosts confidence when two methods agree on the same person", () => {
    const html = `
      <p>Owner: Dave Brennan</p>
      <p>The company was founded by Dave Brennan in 2001.</p>`;
    const [p] = extractPeople(html, "Brennan Roofing");
    expect(p.name).toBe("Dave Brennan");
    expect(p.confidence).toBeGreaterThan(0.9);
  });

  it("ranks the strongest evidence first", () => {
    const html = `
      <p>Managed by Tim Lee</p>
      <p>Owner: Dave Brennan</p>`;
    const people = extractPeople(html, "Brennan Roofing");
    expect(people[0].name).toBe("Dave Brennan");
  });

  it("keeps the raw supporting text for every claim", () => {
    const html = `<p>Owner: Dave Brennan</p>`;
    const [p] = extractPeople(html, "Brennan Roofing");
    expect(p.supportingText).toContain("Dave Brennan");
  });
});

describe("extraction refuses to invent people", () => {
  it("finds nobody on a page with no person data", () => {
    const html = `<h1>Fast, Friendly Service</h1><p>Call now for a free estimate!</p>`;
    expect(extractPeople(html, "Acme HVAC")).toHaveLength(0);
  });

  it("does not treat marketing phrases as names", () => {
    const html = `<p>Free Estimate, Owner Operated</p><p>Contact Us: Learn More</p>`;
    const names = extractPeople(html, "Acme").map((p) => p.name.toLowerCase());
    expect(names).not.toContain("free estimate");
    expect(names).not.toContain("contact us");
  });

  it("does not return the company name as a person", () => {
    const html = `<p>Turner Plumbing, Owner operated since 1990</p>`;
    const names = extractPeople(html, "Turner Plumbing").map((p) => p.name);
    expect(names).not.toContain("Turner Plumbing");
  });

  it("rejects strings containing legal suffixes", () => {
    const html = `<p>Owner: Brennan LLC</p>`;
    expect(extractPeople(html, "Something Else")).toHaveLength(0);
  });

  it("survives malformed JSON-LD without throwing", () => {
    const html = `<script type="application/ld+json">{not valid json</script>
                  <p>Owner: Dave Brennan</p>`;
    const [p] = extractPeople(html, "Brennan Roofing");
    expect(p.name).toBe("Dave Brennan");
  });

  it("handles an empty page", () => {
    expect(extractPeople("", "Acme")).toEqual([]);
  });
});

describe("stripHtml", () => {
  it("removes scripts, styles and tags", () => {
    const out = stripHtml(
      `<style>.a{}</style><script>var x=1</script><p>Hello&nbsp;world</p>`
    );
    expect(out).toBe("Hello world");
  });
});

describe("finding the right pages to crawl", () => {
  it("follows same-origin about/team links", () => {
    const html = `
      <a href="/about-us">About Us</a>
      <a href="/services">Services</a>
      <a href="https://facebook.com/x">Facebook</a>
      <a href="/our-team">Meet the Team</a>`;
    const urls = discoverPeoplePages(html, "https://example.com");
    expect(urls).toContain("https://example.com/about-us");
    expect(urls).toContain("https://example.com/our-team");
    expect(urls.some((u) => u.includes("services"))).toBe(false);
  });

  it("never leaves the origin", () => {
    const html = `<a href="https://evil.com/about">About</a>`;
    expect(discoverPeoplePages(html, "https://example.com")).toHaveLength(0);
  });

  it("skips binary assets", () => {
    const html = `<a href="/about-team.pdf">About the team</a>`;
    expect(discoverPeoplePages(html, "https://example.com")).toHaveLength(0);
  });
});

describe("robots.txt compliance", () => {
  it("respects a wildcard disallow", () => {
    const robots = `User-agent: *\nDisallow: /private`;
    expect(isAllowedByRobots(robots, "/private/x")).toBe(false);
    expect(isAllowedByRobots(robots, "/about")).toBe(true);
  });

  it("honours a full-site block", () => {
    expect(isAllowedByRobots(`User-agent: *\nDisallow: /`, "/about")).toBe(false);
  });

  it("lets a more specific Allow override a Disallow", () => {
    const robots = `User-agent: *\nDisallow: /\nAllow: /about`;
    expect(isAllowedByRobots(robots, "/about")).toBe(true);
    expect(isAllowedByRobots(robots, "/secret")).toBe(false);
  });

  it("obeys rules aimed at our bot by name", () => {
    const robots = `User-agent: DispatchBoardBot\nDisallow: /team`;
    expect(isAllowedByRobots(robots, "/team")).toBe(false);
  });

  it("ignores rules aimed at other bots", () => {
    const robots = `User-agent: GPTBot\nDisallow: /`;
    expect(isAllowedByRobots(robots, "/about")).toBe(true);
  });

  it("allows everything when robots.txt is empty or missing", () => {
    expect(isAllowedByRobots("", "/about")).toBe(true);
  });
});
