export type CccLoopbackHttpUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Parse the single HTTP origin shape admitted by ccc-fusion transport seams.
 * The raw spelling is part of the policy: hostname aliases, IPv6, implicit or
 * zero ports, userinfo, query/hash suffixes, and root-only URLs are rejected.
 */
export function validateCccLoopbackHttpUrl(raw: unknown): CccLoopbackHttpUrlValidation {
  if (typeof raw !== "string") {
    return { ok: false, reason: "URL must be a string" };
  }
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/[^/?#][^?#]*)$/.exec(raw);
  if (!match) {
    return {
      ok: false,
      reason: "URL must use literal http://127.0.0.1 with an explicit positive port and path",
    };
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port > 65_535) {
    return { ok: false, reason: "port must be between 1 and 65535" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "URL is invalid" };
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return { ok: false, reason: "URL is outside the ccc-fusion loopback boundary" };
  }
  return { ok: true, url: raw };
}
