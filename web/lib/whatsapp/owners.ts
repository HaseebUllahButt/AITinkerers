// Who owns which vendor chat, and which chats a given view should show.
//
// The whole team messages vendors through ONE WhatsApp number, so everybody's conversations land
// in a single undifferentiated list. Owning a chat is how a person carves their own out of it —
// the ask, verbatim: "if I mark a number as Arham's contact it should move to my section to avoid
// all the clutter... just like we do on Gmail inboxes but here we have the same number."
//
// Ownership is a LABEL, never a permission. An owned chat leaves everyone else's default view and
// stays one click away in "Everyone", where the row says whose it is. Making it a wall would mean
// a live vendor thread the rest of the team cannot find, and a vendor nobody can find is how a
// deal goes quiet — the opposite of what this is for.

/** "all" · "mine" · "unassigned" · or a colleague's email address. */
export type OwnerFilter = string;

export const OWNER_ALL = "all";
export const OWNER_MINE = "mine";
export const OWNER_UNASSIGNED = "unassigned";

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Does this chat belong in the current view?
 *
 * An unowned chat shows under "unassigned" and "everyone", and nowhere else. Folding unowned chats
 * into "mine" would be friendlier on day one and wrong by week two: every stranger who messages the
 * shared number would silently join one person's list, which is the clutter this exists to remove.
 * The cost is that a brand-new vendor first appears under "unassigned", so the UI carries that
 * view's unread count on its chip rather than letting a first message go unseen.
 */
export function chatMatchesOwner(filter: OwnerFilter, assignedTo: string | null | undefined, me: string | null): boolean {
  if (filter === OWNER_ALL) return true;
  if (filter === OWNER_UNASSIGNED) return !assignedTo;
  if (filter === OWNER_MINE) return same(assignedTo, me);
  return same(assignedTo, filter); // a specific colleague
}
