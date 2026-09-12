// Best-effort recipient timezone inference. We rarely have explicit geo data, so we
// guess from the domain's country TLD, then an explicit country value, else fall back
// to the workflow default. A representative IANA zone is used per country.

const TLD_TZ: Record<string, string> = {
  uk: "Europe/London", gb: "Europe/London", ie: "Europe/Dublin",
  de: "Europe/Berlin", fr: "Europe/Paris", es: "Europe/Madrid", it: "Europe/Rome",
  nl: "Europe/Amsterdam", be: "Europe/Brussels", ch: "Europe/Zurich", at: "Europe/Vienna",
  se: "Europe/Stockholm", no: "Europe/Oslo", dk: "Europe/Copenhagen", fi: "Europe/Helsinki",
  pl: "Europe/Warsaw", pt: "Europe/Lisbon", gr: "Europe/Athens", cz: "Europe/Prague",
  ru: "Europe/Moscow", ua: "Europe/Kiev", tr: "Europe/Istanbul",
  us: "America/New_York", ca: "America/Toronto", mx: "America/Mexico_City",
  br: "America/Sao_Paulo", ar: "America/Argentina/Buenos_Aires", cl: "America/Santiago",
  co: "America/Bogota",
  in: "Asia/Kolkata", pk: "Asia/Karachi", bd: "Asia/Dhaka", lk: "Asia/Colombo",
  cn: "Asia/Shanghai", hk: "Asia/Hong_Kong", tw: "Asia/Taipei", jp: "Asia/Tokyo",
  kr: "Asia/Seoul", sg: "Asia/Singapore", my: "Asia/Kuala_Lumpur", id: "Asia/Jakarta",
  th: "Asia/Bangkok", vn: "Asia/Ho_Chi_Minh", ph: "Asia/Manila",
  ae: "Asia/Dubai", sa: "Asia/Riyadh", il: "Asia/Jerusalem", qa: "Asia/Qatar",
  au: "Australia/Sydney", nz: "Pacific/Auckland",
  za: "Africa/Johannesburg", ng: "Africa/Lagos", ke: "Africa/Nairobi", eg: "Africa/Cairo",
};

const COUNTRY_TZ: Record<string, string> = {
  "united states": "America/New_York", usa: "America/New_York", "united kingdom": "Europe/London",
  uk: "Europe/London", canada: "America/Toronto", germany: "Europe/Berlin", france: "Europe/Paris",
  spain: "Europe/Madrid", italy: "Europe/Rome", netherlands: "Europe/Amsterdam",
  india: "Asia/Kolkata", pakistan: "Asia/Karachi", china: "Asia/Shanghai", japan: "Asia/Tokyo",
  singapore: "Asia/Singapore", australia: "Australia/Sydney", brazil: "America/Sao_Paulo",
  "united arab emirates": "Asia/Dubai", uae: "Asia/Dubai",
};

// Generic multi-country TLDs that give no location signal.
const NEUTRAL_TLDS = new Set(["com", "org", "net", "io", "ai", "co", "app", "dev", "info", "biz", "me", "xyz"]);

export function inferTimezone(host: string | undefined, country: string | undefined, fallback: string): string {
  if (country) {
    const c = COUNTRY_TZ[country.trim().toLowerCase()];
    if (c) return c;
  }
  if (host) {
    const parts = host.toLowerCase().split(".");
    const tld = parts[parts.length - 1];
    // country-code TLD (2 letters, not neutral)
    if (tld && tld.length === 2 && !NEUTRAL_TLDS.has(tld) && TLD_TZ[tld]) return TLD_TZ[tld];
    // second-level like .co.uk / .com.au
    if (parts.length >= 2) {
      const ccTld = parts[parts.length - 1];
      if (TLD_TZ[ccTld]) return TLD_TZ[ccTld];
    }
  }
  return fallback;
}

// Short human label like "9:14 AM PKT" for display on the progress page.
export function localTimeLabel(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString();
  }
}
