export function internalUrl(): string {
  return process.env.APP_URL?.trim() || "http://localhost:3000";
}

export function publicUrl(): string | null {
  return process.env.APP_URL?.trim() || null;
}
