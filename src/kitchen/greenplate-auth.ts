// Sign in to GreenplateAi (Clerk OAuth, public client + PKCE) so the crew acts on one person's own
// kitchen. The login helper gets a refresh token once; the crew service turns it into short-lived
// access tokens for the MCP endpoint and refreshes them before they expire.
import { createHash, randomBytes } from 'node:crypto'

export const CLERK = 'https://clerk.greenplate.ai'
/** The "Kitchen Crew" OAuth app in GreenplateAi's Clerk (public client; the id is not a secret). */
export const CLIENT_ID = process.env.GREENPLATE_CLIENT_ID ?? '6Sx8IOcK8Q0xskiB'
export const SCOPES = 'openid email offline_access'

const b64url = (b: Buffer) => b.toString('base64url')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(o: { redirect: string; challenge: string; state: string; clientId?: string }): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: o.clientId ?? CLIENT_ID, redirect_uri: o.redirect, scope: SCOPES,
    state: o.state, code_challenge: o.challenge, code_challenge_method: 'S256',
  })
  return `${CLERK}/oauth/authorize?${q}`
}

export interface Tokens { access: string; refresh?: string; expiresIn: number }

async function tokenCall(body: Record<string, string>, f: typeof fetch): Promise<Tokens> {
  const r = await f(`${CLERK}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  })
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!r.ok || !j.access_token) throw new Error(`GreenplateAi sign-in refused (${r.status} ${j.error ?? ''} ${j.error_description ?? ''})`.trim())
  return { access: j.access_token, refresh: j.refresh_token, expiresIn: j.expires_in ?? 3600 }
}

export const exchangeCode = (code: string, verifier: string, redirect: string, f: typeof fetch = fetch) =>
  tokenCall({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect }, f)

export const refreshTokens = (refresh: string, f: typeof fetch = fetch) =>
  tokenCall({ grant_type: 'refresh_token', refresh_token: refresh }, f)

/**
 * Keeps a fresh access token from a refresh token. If Clerk hands back a new refresh token
 * (rotation), onRotate gets it so it can be saved; the old one may stop working.
 */
export function greenplateSession(refresh: string, onRotate: (next: string) => Promise<void> = async () => {}, f: typeof fetch = fetch, now = () => Date.now()) {
  let current = refresh
  let access = ''
  let expires = 0
  let pending: Promise<string> | undefined
  async function renew(): Promise<string> {
    const t = await refreshTokens(current, f)
    if (t.refresh && t.refresh !== current) { current = t.refresh; await onRotate(current).catch((e) => console.warn(`could not save the new GreenplateAi refresh token: ${(e as Error).message}`)) }
    access = t.access
    expires = now() + t.expiresIn * 1000
    return access
  }
  return {
    /** An access token with at least a minute left. */
    async token(): Promise<string> {
      if (access && now() < expires - 60_000) return access
      pending ??= renew().finally(() => { pending = undefined })
      return pending
    },
  }
}
