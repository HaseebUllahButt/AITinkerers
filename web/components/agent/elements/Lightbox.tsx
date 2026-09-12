"use client";

// SearchOps Agent — the full-size image viewer.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §8.4.
//
// Built on the app's Dialog primitive, which supplies the four things every hand-rolled lightbox
// misses: focus trap, Escape to close, body scroll lock, and focus restore to the thumbnail.
//
// Why this file reaches for `DialogPrimitive.Popup` instead of `<DialogContent>`: DialogContent
// hardcodes both a `bg-black/10` backdrop and a popover-styled panel (bg-popover, ring, padding,
// max-w-sm). The lightbox needs the opposite of both — an 80% backdrop and a panel that is nothing
// but the picture. Everything else (root, portal, backdrop, close) comes from the app's wrappers,
// and `DialogPrimitive` here is the very same Base UI package those wrappers are built on, not a
// second dialog library.

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";

import type { AgentElement } from "../types";

export interface LightboxProps {
  /** The image being shown. `null` renders nothing — the dialog is not mounted at all. */
  element: AgentElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function Lightbox({ element, open, onOpenChange }: LightboxProps) {
  // Guard on the element as well as `open`: the element can be removed (element_removed) while the
  // dialog is up, and rendering a Popup with no <img> leaves an empty focus trap the user can only
  // escape with Escape.
  if (!element?.url) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        {/* Overrides the wrapper's bg-black/10 + blur. A lightbox needs the room dark, and the blur
            costs a full-viewport filter pass on every frame of the open animation. */}
        <DialogOverlay className="bg-black/80 supports-backdrop-filter:backdrop-blur-none" />
        <DialogPrimitive.Popup
          data-slot="agent-lightbox"
          className="fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-md border-none bg-transparent p-0 shadow-none outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {/* The dialog's accessible name. Visually redundant over the picture, required for the
              screen-reader announcement. */}
          <DialogTitle className="sr-only">{element.name}</DialogTitle>

          {/* eslint-disable-next-line @next/next/no-img-element -- see ImageElement.tsx: the surface
              renders provider CDN URLs directly, unoptimized and un-proxied. */}
          <img
            src={element.url}
            alt={element.name}
            className="block max-h-[90vh] max-w-[90vw] object-contain"
            // The backdrop dismisses on outside press; the popup is sized to the picture so clicks
            // beside it land on the backdrop. This stopPropagation is the belt to that braces — a
            // click on the picture itself must never dismiss.
            onClick={(e) => e.stopPropagation()}
          />

          <DialogClose
            aria-label="Close image"
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-4 right-4 bg-black/50 text-white hover:bg-black/70 hover:text-white focus:ring-2 focus:ring-white"
              />
            }
          >
            <XIcon aria-hidden />
          </DialogClose>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
