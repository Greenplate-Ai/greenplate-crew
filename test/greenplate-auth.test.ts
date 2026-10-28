import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authorizeUrl, greenplateSession, pkce } from '../src/kitchen/greenplate-auth.js'

describe('GreenplateAi sign-in', () => {
  it('makes an S256 PKCE pair', () => {
    const { verifier, challenge } = pkce()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('asks for a refresh token with PKCE', () => {
    const u = new URL(authorizeUrl({ redirect: 'http://127.0.0.1:8765/callback', challenge: 'c', state: 's', clientId: 'id' }))
    expect(u.origin + u.pathname).toBe('https://clerk.greenplate.ai/oauth/authorize')
    expect(u.searchParams.get('scope')).toContain('offline_access')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('resource')).toBe('https://mcp.greenplate.ai/mcp')
  })

  it('reuses a fresh token, refreshes near expiry and saves a rotated refresh token', async () => {
    let t = 0
    const bodies: string[] = []
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      t++
      return Response.json({ access_token: `a${t}`, refresh_token: `r${t}`, expires_in: 600 })
    }) as unknown as typeof fetch
    let clock = 0
    const saved: string[] = []
    const s = greenplateSession('r0', async (next) => { saved.push(next) }, f, () => clock)
    expect(await Promise.all([s.token(), s.token()])).toEqual(['a1', 'a1'])
    clock = 500_000
    expect(await s.token()).toBe('a1')
    clock = 560_000
    expect(await s.token()).toBe('a2')
    expect(bodies[1]).toContain('refresh_token=r1')
    expect(saved).toEqual(['r1', 'r2'])
  })

  it('says why when GreenplateAi refuses', async () => {
    const f = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch
    await expect(greenplateSession('old', undefined, f).token()).rejects.toThrow(/invalid_grant/)
  })
})
