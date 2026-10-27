// Load the crew's keys from Azure Key Vault into this process's memory at startup, using the
// machine's Azure identity (Azure Arc on the home server, managed identity in Azure). No key is
// ever written to disk. Vault secret names are the env names in kebab case with a "crew-" prefix:
// ELEVENLABS_API_KEY -> crew-elevenlabs-api-key.
import { readFileSync } from 'node:fs'

export const CREW_KEYS = ['CREW_APP_TOKEN', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'MODEL_API_KEY', 'GREENPLATE_MCP_TOKEN', 'CREW_CAN_WRITE'] as const
export const secretName = (env: string) => `crew-${env.toLowerCase().replace(/_/g, '-')}`

const ARC_TOKEN_URL = 'http://localhost:40342/metadata/identity/oauth2/token?api-version=2020-06-01&resource=https%3A%2F%2Fvault.azure.net'
const AZURE_TOKEN_URL = 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net'

/** An access token for Key Vault from the machine's identity: Azure Arc first, then Azure's own endpoint. */
export async function vaultToken(f: typeof fetch = fetch, readKey: (p: string) => string = (p) => readFileSync(p, 'utf8')): Promise<string> {
  try {
    // Arc answers 401 with the path of a one-time key file only root or the himds group can read.
    const first = await f(ARC_TOKEN_URL, { headers: { Metadata: 'true' } })
    const challenge = first.headers.get('www-authenticate') ?? ''
    const path = /Basic realm=(.+)$/.exec(challenge)?.[1]
    if (first.status === 401 && path) {
      const r = await f(ARC_TOKEN_URL, { headers: { Metadata: 'true', Authorization: `Basic ${readKey(path.trim())}` } })
      if (r.ok) return ((await r.json()) as { access_token: string }).access_token
    }
  } catch { /* not an Arc machine */ }
  const r = await f(AZURE_TOKEN_URL, { headers: { Metadata: 'true' } })
  if (!r.ok) throw new Error(`no machine identity for Key Vault (${r.status})`)
  return ((await r.json()) as { access_token: string }).access_token
}

/** Fills process.env with whichever crew keys exist in the vault; returns the names loaded. */
export async function loadKeysFromVault(vault: string, f: typeof fetch = fetch, token?: string): Promise<string[]> {
  const t = token ?? (await vaultToken(f))
  const loaded: string[] = []
  for (const env of CREW_KEYS) {
    if (process.env[env]) continue
    const r = await f(`https://${vault}.vault.azure.net/secrets/${secretName(env)}?api-version=7.4`, { headers: { Authorization: `Bearer ${t}` } })
    if (r.status === 404) continue
    if (!r.ok) throw new Error(`Key Vault ${r.status} reading ${secretName(env)}`)
    const value = ((await r.json()) as { value?: string }).value
    if (value) { process.env[env] = value; loaded.push(env) }
  }
  return loaded
}
