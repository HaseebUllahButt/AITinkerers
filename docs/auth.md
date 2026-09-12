# Auth

> **Status: superseded in part.** The chat surface is Slack (HMAC verify, not Discord). The credential rules still apply; open sign-in caveat in web/auth.ts is the live version of 'must be replaced before public'.

The agent never holds a raw secret. Credentials live server-side, scoped to one thing, with reads and writes separated.

## What needs credentials

| What | How | Today |
|---|---|---|
| Chat commands | Discord bot token + signature check on every request | required |
| Who is asking | map the Discord user id to a person row | no login needed |
| Repo writes | GitHub token, one repo | PAT in env |
| Live site reads | nothing, the pages are public | — |
| Search Console | Google OAuth, read-only scope | skip |
| Models | OpenRouter key, server-side only | env var |
| Web report + approval links | signed token in the URL, short expiry | required |

## Rules

- Keys stay in the server environment or a secret manager. Never in a client bundle, never inside a prompt, never echoed back into chat.
- Read and write credentials are separate. Checks run with read-only access. Only an approved change touches a write token.
- **Approval links must be signed and expire.** An unsigned approval URL means anyone who can see the channel can change your live site.
- Every token is scoped to one repo or one property. No account-wide access.
- The receipt records which credential performed the write.
- One place to revoke. When a token dies, jobs fail closed rather than half-applying.

## Verifying Discord

Discord signs every request. Check the Ed25519 signature against your public key and reject anything that fails, before doing any work. This is not optional — it's how you avoid a forged command opening a pull request.

## Later

- GitHub App instead of a PAT: per-repo install, revocable, not tied to a personal account
- Google OAuth for Search Console
- A real login on the web surface instead of signed links
- Per-project credential storage once there's more than one project
