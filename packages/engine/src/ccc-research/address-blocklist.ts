/*
FNXC:CccResearchAddressBlocklist 2026-10-15-00:33:
Address blocklist for the controller-side research fetch (request-to-code PRD v3, card C5, CONTRACT-v3.5 section 2.14, ADR C Q4). Every address a research host resolves to is checked here before the connection is made, so a public-looking name cannot lead the controller to a machine-local or private service.

Why a new list and not `isIpBlocked` in `web-fetch.ts`: that check is private, only covers loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0/8, `::1`, fc00::/7 and fe80::/10, and reads IPv4-mapped IPv6 only in dotted form. It accepts 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4, the three TEST-NETs, `::`, ff00::/8, 64:ff9b::/96, 2002::/16 and `::ffff:7f00:1`. `web-fetch.ts` may adopt this module later; it is not changed now.

What is blocked (IPv4): 0/8, 10/8, 100.64/10 (carrier-grade NAT), 127/8, 169.254/16, 172.16/12, 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1), 192.88.99.0/24, 192.168/16, 198.18.0.0/15 (benchmarking), 198.51.100.0/24 (TEST-NET-2), 203.0.113.0/24 (TEST-NET-3), 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved, which holds the broadcast address).
What is blocked (IPv6): ::/96 (unspecified, loopback and the old IPv4-compatible form), 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64, which embeds an IPv4 address), 100::/64, 2001::/23 (protocol assignments, which holds Teredo), 2001:db8::/32 and 3fff::/20 (documentation), 2002::/16 (6to4, which embeds an IPv4 address), fc00::/7, fe80::/10, fec0::/10 and ff00::/8 (multicast).
IPv4-mapped IPv6 (`::ffff:a.b.c.d` and the hex spelling `::ffff:7f00:1`) is normalised to the embedded IPv4 address by the explicit parse below, never by trusting the platform's list, and is then checked as IPv4.

Fail closed: an address that does not parse as an IP literal (empty, a host name, a padded string, a non-canonical IPv4 spelling such as `0177.0.0.1`, a non-string) is reported as blocked. An IPv6 zone suffix (`fe80::1%en0`) is dropped before the check.
*/
import { BlockList, isIP } from "node:net";

const IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

const IPV6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["3fff::", 20],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];

/** A fresh `net.BlockList` holding every range above. */
export function buildCccResearchAddressBlocklist(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of IPV4_RANGES) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of IPV6_RANGES) list.addSubnet(network, prefix, "ipv6");
  return list;
}

let shared: BlockList | null = null;

/** Expands an IPv6 literal into eight 16-bit groups, or null when it is not a well-formed literal. */
function ipv6Groups(literal: string): number[] | null {
  let text = literal.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
    if (octets.length !== 4 || octets.some((octet) => !(octet >= 0 && octet <= 255))) return null;
    text = `${text.slice(0, lastColon + 1)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...rest];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

/** The IPv4 address embedded in `::ffff:0:0/96`, or null for any other IPv6 address. */
function mappedIpv4(literal: string): string | null {
  const groups = ipv6Groups(literal);
  if (groups === null || groups.length !== 8) return null;
  if (groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return null;
  return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
}

/** True when the address is in any blocked range, is an IPv4-mapped form of one, or is not an IP literal at all. */
export function isCccResearchAddressBlocked(address: string): boolean {
  if (typeof address !== "string") return true;
  const zone = address.indexOf("%");
  const literal = zone === -1 ? address : address.slice(0, zone);
  const family = isIP(literal);
  if (family === 0) return true;
  shared ??= buildCccResearchAddressBlocklist();
  if (family === 4) return shared.check(literal, "ipv4");
  const embedded = mappedIpv4(literal);
  if (embedded !== null) return shared.check(embedded, "ipv4");
  return shared.check(literal, "ipv6");
}
