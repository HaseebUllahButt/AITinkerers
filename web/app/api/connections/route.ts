import { NextResponse } from "next/server";

import { auth } from "@auth";
import { encrypt } from "@/lib/connections/crypto";
import { execute, query } from "@/lib/db/pg";
import { serviceAccountEmail } from "@/lib/indexing/gsc";

type Kind = "github" | "google" | "slack" | "smtp";

function domainFrom(input: string): { url: string; domain: string } {
  const raw = input.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  return { url: url.toString(), domain: url.hostname.replace(/^www\./, "").toLowerCase() };
}

async function actor(): Promise<string> {
  const session = await auth().catch(() => null);
  return session?.user?.email || "demo-user";
}

export async function GET(req: Request) {
  try {
    const target = domainFrom(new URL(req.url).searchParams.get("url") ?? "");
    const rows = await query<{ kind: Kind; config: Record<string, unknown>; created_at: string }>(
      `select c.kind, c.config, c.created_at
         from connections c join sites s on s.id = c.site_id
        where s.domain = $1 order by c.kind`,
      [target.domain],
    );
    return NextResponse.json({ connections: rows, serviceAccountEmail: serviceAccountEmail() });
  } catch {
    return NextResponse.json({ connections: [], serviceAccountEmail: serviceAccountEmail() });
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Send a JSON body." }, { status: 400 }); }

  const kind = body.kind as Kind;
  if (!["github", "google", "slack", "smtp"].includes(kind)) {
    return NextResponse.json({ error: "Unknown connection kind." }, { status: 400 });
  }

  let target: { url: string; domain: string };
  try { target = domainFrom(String(body.url ?? "")); }
  catch { return NextResponse.json({ error: "A valid site URL is required." }, { status: 400 }); }

  const connectedBy = await actor();
  let config: Record<string, unknown> = {};
  let secret: string | null = null;

  try {
    if (kind === "github") {
      const repository = String(body.repository ?? "").trim();
      const token = String(body.token ?? "").trim();
      if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !token) {
        return NextResponse.json({ error: "Repository (owner/name) and token are required." }, { status: 400 });
      }
      config = { repository };
      secret = encrypt(token);
    }

    if (kind === "google") {
      const mode = String(body.mode ?? "");
      const property = String(body.property ?? "").trim();
      if (mode === "oauth") {
        return NextResponse.json(
          { error: "Google OAuth is not available in this demo. Use the service-account path." },
          { status: 501 },
        );
      }
      const email = serviceAccountEmail();
      if (!email) {
        return NextResponse.json({ error: "The SearchOps service account is not configured." }, { status: 503 });
      }
      if (!property) return NextResponse.json({ error: "Search Console property is required." }, { status: 400 });
      config = { mode: "service_account", property, serviceAccountEmail: email };
    }

    if (kind === "slack") {
      const teamId = String(body.teamId ?? "").trim();
      const channelId = String(body.channelId ?? "").trim();
      const token = String(body.token || process.env.SLACK_BOT_TOKEN || "").trim();
      if (!teamId || !channelId || !token) {
        return NextResponse.json({ error: "Slack team, channel, and bot token are required." }, { status: 400 });
      }
      config = { teamId, channelId };
      secret = encrypt(token);
    }

    // Gmail app-password SMTP — the outbound half of the backlink outreach path. `user` is the
    // Gmail address, `pass` the app password (encrypted into secret_enc like every other token).
    if (kind === "smtp") {
      const host = String(body.host ?? "smtp.gmail.com").trim();
      const port = Number(body.port ?? 465);
      const user = String(body.user ?? "").trim();
      const pass = String(body.pass ?? "").trim();
      const fromName = String(body.fromName ?? "").trim();
      if (!host || !Number.isFinite(port) || !user || !pass) {
        return NextResponse.json(
          { error: "SMTP host, port, Gmail address, and app password are required." },
          { status: 400 },
        );
      }
      config = { host, port, user, fromName };
      secret = encrypt(pass);
    }

    const sites = await execute<{ id: string }>(
      `insert into sites (url, domain, brand, created_by)
       values ($1, $2, $3, $4)
       on conflict (domain) do update set url = excluded.url,
         brand = coalesce(excluded.brand, sites.brand)
       returning id`,
      [target.url, target.domain, typeof body.brand === "string" ? body.brand : null, connectedBy],
    );
    const siteId = sites[0].id;
    await execute(
      `insert into connections (site_id, kind, config, secret_enc, connected_by)
       values ($1, $2, $3::jsonb, $4, $5)
       on conflict (site_id, kind) do update set
         config = excluded.config, secret_enc = excluded.secret_enc,
         connected_by = excluded.connected_by, created_at = now()`,
      [siteId, kind, JSON.stringify(config), secret, connectedBy],
    );
    if (kind === "slack") {
      await execute(
        `insert into surface_channels (surface, workspace_id, channel_id, site_id, bound_by)
         values ('slack', $1, $2, $3, $4)
         on conflict (surface, workspace_id, channel_id) do update set
           site_id = excluded.site_id, bound_by = excluded.bound_by, bound_at = now()`,
        [config.teamId, config.channelId, siteId, connectedBy],
      );
    }
    return NextResponse.json({ connected: true, kind, config });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the connection." },
      { status: 500 },
    );
  }
}
