// Renew the crew's GreenplateAi sign-in held in Key Vault: npm run kitchen-renew
// Use before restarting the crew service if it may not have saved its newest token. Uses your own
// `az login`; prints no token.
import { execFileSync } from 'node:child_process'
import { refreshTokens } from './greenplate-auth.js'
import { saveSecret, secretName } from './keyvault.js'

const VAULT = process.env.AZURE_KEYVAULT ?? 'kv-i2-dev-bpwlfu'
const t = execFileSync('az', ['account', 'get-access-token', '--resource', 'https://vault.azure.net', '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
const r = await fetch(`https://${VAULT}.vault.azure.net/secrets/${secretName('GREENPLATE_REFRESH_TOKEN')}?api-version=7.4`, { headers: { Authorization: `Bearer ${t}` } })
if (!r.ok) throw new Error(`Key Vault ${r.status} reading the sign-in`)
const current = ((await r.json()) as { value: string }).value
try {
  const next = await refreshTokens(current)
  await saveSecret(VAULT, 'GREENPLATE_REFRESH_TOKEN', next.refresh ?? current, fetch, t)
  console.log('Sign-in still good; saved a fresh one. Safe to restart the crew.')
} catch (e) {
  console.log(`The saved sign-in no longer works (${(e as Error).message}). Run npm run kitchen-login.`)
  process.exit(2)
}
