import type { AuditResult } from "@/lib/audit/run";

import demo from "./audit-demo.json";

/**
 * A complete audit of a site that does not exist.
 *
 * Reshaped from a real run rather than hand-written, so it cannot drift out of shape from the type
 * it has to satisfy, and so every panel is exercised — three engines answering, competitors
 * profiled, gaps found, suggestions written. A hand-made fixture tends to fill only the fields
 * whoever wrote it remembered.
 *
 * Every name is fictional and every domain sits on `.example`, which RFC 2606 reserves and no one
 * can ever register, so nothing here can be mistaken for a real company or quietly start pointing
 * at one.
 */
export const DEMO_AUDIT = demo as unknown as AuditResult;

export const DEMO_BRAND = DEMO_AUDIT.brand;
