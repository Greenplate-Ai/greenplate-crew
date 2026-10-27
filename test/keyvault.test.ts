import { afterEach, describe, expect, it } from 'vitest'
import { loadKeysFromVault, secretName, vaultToken } from '../src/kitchen/keyvault.js'

afterEach(() => { delete process.env.ELEVENLABS_API_KEY; delete process.env.MODEL_API_KEY })

describe('Key Vault keys', () => {
  it('maps env names to vault secret names', () => {
    expect(secretName('ELEVENLABS_API_KEY')).toBe('crew-elevenlabs-api-key')
  })

  it('gets a token through the Arc challenge', async () => {
    const calls: RequestInit[] = []
    const f = (async (_url: string, init: RequestInit) => {
      calls.push(init)
      if (calls.length === 1) return new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm=/var/opt/azcmagent/tokens/x.key' } })
      return Response.json({ access_token: 'tok' })
    }) as unknown as typeof fetch
    expect(await vaultToken(f, () => 'secretkey')).toBe('tok')
    expect((calls[1]?.headers as Record<string, string>).Authorization).toBe('Basic secretkey')
  })

  it('loads the secrets that exist and skips the missing ones', async () => {
    const f = (async (url: string) => {
      if (url.includes('crew-elevenlabs-api-key')) return Response.json({ value: 'el-key' })
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const loaded = await loadKeysFromVault('kv-test', f, 'tok')
    expect(loaded).toEqual(['ELEVENLABS_API_KEY'])
    expect(process.env.ELEVENLABS_API_KEY).toBe('el-key')
    expect(process.env.MODEL_API_KEY).toBeUndefined()
  })
})
