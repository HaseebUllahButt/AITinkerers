"use client";

// Summit Agent — a downloadable file element.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §8.7.
//
// A 58px card wrapped in a real `<a download target="_blank">` — not a button with a JS click
// handler, so middle-click, cmd-click and "Save link as…" all behave. The tooltip is not decoration:
// the name is truncated to 80% of the card, and the tooltip IS the accessible fallback for what got
// cut off.

import { memo } from "react";
import {
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  type LucideIcon,
} from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { FILE_CARD_HEIGHT_PX, TOOLTIP_DELAY_MS } from "../constants";
import type { AgentElement } from "../types";

export interface FileElementProps {
  element: AgentElement;
  className?: string;
}

/**
 * filename extension → MIME subtype → `txt`.
 *
 * In that order on purpose: the agent's own filenames are the most specific signal, and a generic
 * `application/octet-stream` from a CDN would otherwise erase a perfectly good `.csv`.
 */
function resolveExtension(element: AgentElement): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(element.name)?.[1];
  if (fromName) return fromName.toLowerCase();
  // "image/svg+xml" → "svg"; the suffix after `+` is a serialization, not a file type.
  const subtype = element.mime?.split("/")[1]?.split("+")[0];
  if (subtype) return subtype.toLowerCase();
  return "txt";
}

const GLYPHS: Readonly<Record<string, LucideIcon>> = {
  csv: FileSpreadsheetIcon,
  tsv: FileSpreadsheetIcon,
  xls: FileSpreadsheetIcon,
  xlsx: FileSpreadsheetIcon,
  png: FileImageIcon,
  jpg: FileImageIcon,
  jpeg: FileImageIcon,
  gif: FileImageIcon,
  webp: FileImageIcon,
  svg: FileImageIcon,
  mp4: FileVideoIcon,
  mov: FileVideoIcon,
  webm: FileVideoIcon,
  mp3: FileAudioIcon,
  wav: FileAudioIcon,
  zip: FileArchiveIcon,
  gz: FileArchiveIcon,
  tar: FileArchiveIcon,
  json: FileCodeIcon,
  html: FileCodeIcon,
  xml: FileCodeIcon,
  js: FileCodeIcon,
  ts: FileCodeIcon,
  py: FileCodeIcon,
  sql: FileCodeIcon,
};

function FileElementImpl({ element, className }: FileElementProps) {
  const ext = resolveExtension(element);
  const Glyph = GLYPHS[ext] ?? FileTextIcon;
  const ready = element.status === "ready" && !!element.url;

  const card = (
    <span className="flex w-full items-center gap-3 px-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Glyph className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="w-[80%] truncate text-sm font-medium">{element.name}</span>
        <span className="text-xs text-muted-foreground uppercase">
          {element.status === "error" ? "Unavailable" : element.status === "pending" ? "Preparing…" : ext}
        </span>
      </span>
      {ready && <DownloadIcon className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />}
    </span>
  );

  // Same box in every state — a pending file must not resize into a ready one when its URL lands.
  const shell = cn(
    "flex items-center rounded-lg border border-border bg-background text-left transition-colors",
    ready ? "hover:bg-muted" : "opacity-60",
    className,
  );
  const style = { height: FILE_CARD_HEIGHT_PX };

  return (
    <Tooltip>
      {/* The delay lives on the trigger, not a nested Provider: the app-wide default (700ms in most
          tooltip kits) means the tooltip never appears while the pointer is skimming a file list,
          and the tooltip is the only way to read a truncated filename. */}
      <TooltipTrigger
        delay={TOOLTIP_DELAY_MS}
        render={
          ready ? (
            // `download` asks the browser to save rather than navigate; `target="_blank"` is the
            // fallback for cross-origin CDN responses, where `download` is ignored and navigating
            // away from a live stream would kill the run.
            <a
              href={element.url}
              download={element.name}
              target="_blank"
              rel="noreferrer noopener"
              className={shell}
              style={style}
            />
          ) : (
            <span aria-disabled className={shell} style={style} />
          )
        }
      >
        {card}
      </TooltipTrigger>
      {/* The untruncated name. This is the accessible fallback for the 80% truncation above. */}
      <TooltipContent className="max-w-sm break-all">{element.name}</TooltipContent>
    </Tooltip>
  );
}

export const FileElement = memo(FileElementImpl);
FileElement.displayName = "FileElement";
