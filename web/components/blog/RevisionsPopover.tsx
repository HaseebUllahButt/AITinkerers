"use client";

// Snapshot history for one draft — the "let us start off from that point" surface.
//
// Restore is itself a normal save (reason: "pre_restore"), so the state being replaced is
// snapshotted first and restoring is undoable. That matters because picking the wrong row from a
// list of timestamps is easy.
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { History, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BlogDraft } from "@/lib/db/queries";

interface RevisionRow {
  id: number;
  rev: number;
  reason: string;
  created_at: string;
  created_by?: string | null;
  title: string;
  word_count: number;
}

/** Plain-English labels — "pre_publish" means nothing to the person reading the list. */
const REASON_LABEL: Record<string, string> = {
  autosave: "autosave",
  manual: "manual save",
  pre_conflict_overwrite: "replaced by another editor",
  pre_sync: "before syncing to Strapi",
  pre_publish: "before publishing",
  pre_restore: "before a restore",
};

interface Props {
  draftId: string;
  onRestored: (draft: BlogDraft) => void;
}

export function RevisionsPopover({ draftId, onRestored }: Props) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch(`/api/blog/drafts/${draftId}/revisions`).then((r) => r.json());
      setRows(d?.ok ? d.revisions : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  async function restore(revisionId: number) {
    setRestoring(revisionId);
    try {
      const d = await fetch(`/api/blog/drafts/${draftId}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision_id: revisionId }),
      }).then((r) => r.json());
      if (d?.ok) {
        onRestored(d.draft);
        toast.success("Restored. The version you replaced is still in this history.");
        await load();
      } else {
        toast.error(d?.error ?? "Restore failed.");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Restore failed.");
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Popover onOpenChange={(open: boolean) => { if (open) void load(); }}>
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost" className="h-10 gap-1 text-xs text-muted-foreground">
            <History className="h-3 w-3" /> History
          </Button>
        }
      />
      <PopoverContent className="w-80 p-0">
        <div className="px-3 py-2 border-b border-border text-xs font-medium">Version history</div>
        {loading ? (
          <div className="p-4 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" /></div>
        ) : !rows?.length ? (
          <p className="p-3 text-xs text-muted-foreground">
            No snapshots yet. One is kept whenever you make a substantial edit, and always before a
            sync, a publish, or a restore.
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="px-3 py-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs truncate">{r.title || "Untitled"}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()} · {r.word_count} words
                    <br />
                    {REASON_LABEL[r.reason] ?? r.reason}{r.created_by ? ` · ${r.created_by}` : ""}
                  </p>
                </div>
                <Button
                  size="xs" variant="ghost" className="h-10 px-1.5 shrink-0"
                  disabled={restoring !== null} onClick={() => restore(r.id)}
                >
                  {restoring === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                </Button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
