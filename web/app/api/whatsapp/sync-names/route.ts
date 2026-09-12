import { NextRequest, NextResponse } from "next/server";
import { listWhatsappVendorsForNameSync, renameWhatsappVendor } from "@/lib/db/queries";
import { fetchBridgeContactName, waBridgeEnabled, PHONEBOOK_ACTOR } from "@/lib/whatsapp/bridge";
import { normalizeWaNumber } from "@/lib/email/whatsappNote";
import { identifyCaller } from "@/lib/auth/service";

// One address-book lookup per vendor, and the list is dozens, not thousands.
export const maxDuration = 300;

// POST /api/whatsapp/sync-names — take every vendor's name from the linked phone's contacts.
//
// The vendors already in the table were filed under WhatsApp pushnames (the string each account
// holder typed into their OWN profile), which is how a vendor saved on the team's phone as "ali
// Ahmed Vendor" came to be greeted as "Katie". Making the tool agree with the phone is not
// something anyone should have to do 38 times by hand, so this does it in one pass.
//
// Two things it will not do:
//   - overwrite a name a PERSON typed in the UI. An explicit correction outranks the address book;
//     only names never confirmed, or previously set by this same sync, are touched.
//   - invent one. A number that isn't in the phone's contacts keeps whatever it has and stays
//     unconfirmed, which is the honest answer to "what is this person called".
export async function POST(req: NextRequest) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!waBridgeEnabled()) {
    return NextResponse.json({ error: "The WhatsApp bridge isn't configured, so there are no phone contacts to read." }, { status: 503 });
  }
  try {
    const vendors = await listWhatsappVendorsForNameSync();
    let renamed = 0, confirmed = 0, unsaved = 0, skipped = 0;
    const changes: Array<{ from: string; to: string }> = [];
    const failures: string[] = [];

    for (const v of vendors) {
      // Someone typed this name deliberately — leave it alone.
      if (v.confirmed && v.named_by !== PHONEBOOK_ACTOR) { skipped++; continue; }
      const digits = normalizeWaNumber(v.wa_url);
      if (!digits) { skipped++; continue; }
      const saved = await fetchBridgeContactName(digits).catch(() => null);
      if (!saved) { unsaved++; continue; } // not in the phone book — say nothing, claim nothing
      try {
        await renameWhatsappVendor(v.author_id, saved, PHONEBOOK_ACTOR);
        if (saved === v.name) confirmed++;
        else { renamed++; changes.push({ from: v.name, to: saved }); }
      } catch (e) {
        // One vendor failing must not silently shrink the report into "everything else was fine".
        failures.push(`${v.name || digits}: ${e instanceof Error ? e.message : "write failed"}`);
      }
    }
    return NextResponse.json({
      ok: true, total: vendors.length, renamed, confirmed, unsaved, skipped,
      changes: changes.slice(0, 50), failures,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sync failed" }, { status: 500 });
  }
}
