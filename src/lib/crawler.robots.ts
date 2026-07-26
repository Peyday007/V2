// Pure robots.txt evaluation, split out so it can be unit-tested.

/** Minimal robots.txt evaluation for our User-Agent. */
export function isAllowedByRobots(robotsTxt: string, path: string): boolean {
  const lines = robotsTxt.split("\n").map((l) => l.trim());
  let applies = false;
  const disallows: string[] = [];
  const allows: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      const ua = value.toLowerCase();
      applies = ua === "*" || ua.includes("dispatchboardbot");
    } else if (applies && key === "disallow" && value) {
      disallows.push(value);
    } else if (applies && key === "allow" && value) {
      allows.push(value);
    }
  }

  // Longest matching rule wins; Allow beats Disallow at equal length.
  let verdict = true;
  let bestLen = -1;
  for (const rule of disallows) {
    if (path.startsWith(rule) && rule.length > bestLen) {
      bestLen = rule.length;
      verdict = false;
    }
  }
  for (const rule of allows) {
    if (path.startsWith(rule) && rule.length >= bestLen) {
      bestLen = rule.length;
      verdict = true;
    }
  }
  return verdict;
}

