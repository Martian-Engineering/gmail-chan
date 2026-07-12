import { normalizeEmailAddress } from "./target.js";

function matchesAddressPolicy(address: string, rawEntry: string): boolean {
  const entry = rawEntry.trim().toLowerCase();
  if (entry === "*") {
    return true;
  }
  if (entry.startsWith("@")) {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const allowedDomain = entry.slice(1);
    return domain === allowedDomain || domain.endsWith(`.${allowedDomain}`);
  }
  return address === normalizeEmailAddress(entry);
}

/** Returns whether one email address is admitted by an exact/domain policy list. */
export function isAddressAllowed(
  address: string,
  entries: readonly string[],
): boolean {
  const normalized = normalizeEmailAddress(address);
  return normalized
    ? entries.some((entry) => matchesAddressPolicy(normalized, entry))
    : false;
}
