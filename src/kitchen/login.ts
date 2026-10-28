// Sign the crew in to your GreenplateAi kitchen: npm run kitchen-login
// Opens GreenplateAi's sign-in page in the browser, checks the MCP endpoint accepts the result, and
// saves the refresh token straight into Key Vault (signed in with your own `az login`). No token is
// printed or written to disk. Then restart the crew service so it picks it up.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { authorizeUrl, exchangeCode, pkce, refreshTokens } from './greenplate-auth.js'
import { connectKitchen } from './service.js'
import { saveSecret } from './keyvault.js'

const VAULT = process.env.AZURE_KEYVAULT ?? 'kv-i2-dev-bpwlfu'
const PORT = 8765
const REDIRECT = `http://127.0.0.1:${PORT}/callback`

const { verifier, challenge } = pkce()
const state = randomBytes(16).toString('base64url')
const url = authorizeUrl({ redirect: REDIRECT, challenge, state })

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', REDIRECT)
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
    const page = (msg: string) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><body style="font:18px system-ui;padding:40px">${msg}</body>`)
    server.close()
    if (u.searchParams.get('state') !== state) { page('Sign-in did not match. Run npm run kitchen-login again.'); reject(new Error('state mismatch')); return }
    const c = u.searchParams.get('code')
    if (!c) { page('GreenplateAi did not sign in.'); reject(new Error(u.searchParams.get('error_description') ?? u.searchParams.get('error') ?? 'no code')); return }
    page('Signed in. You can close this tab and go back to the terminal.')
    resolve(c)
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Opening GreenplateAi sign-in in your browser. If it does not open, visit:\n' + url + '\n')
    const opener = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const
      : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const
    spawn(opener[0], [...opener[1]], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  })
  setTimeout(() => { server.close(); reject(new Error('timed out waiting for sign-in (5 min)')) }, 300_000).unref()
})

const first = await exchangeCode(code, verifier, REDIRECT)
if (!first.refresh) throw new Error('GreenplateAi gave no refresh token; the Kitchen Crew app needs the offline_access scope.')
console.log(`Signed in. Access token lasts ${Math.round(first.expiresIn / 60)} min.`)

// Does the kitchen accept it? Connecting runs the MCP handshake with the token.
const kitchen = await connectKitchen({ token: first.access }).catch((e) => { throw new Error(`GreenplateAi MCP refused the token: ${(e as Error).message}`) })
const who = await kitchen.call('node_whoami').catch(() => undefined)
await kitchen.close()
console.log(`Kitchen accepts it${who?.ok ? '' : ' (connected; whoami not available)'}.`)

// One refresh now, to learn whether Clerk rotates refresh tokens; keep whichever is newest.
const second = await refreshTokens(first.refresh)
const refresh = second.refresh ?? first.refresh
console.log(`Refresh works; Clerk ${second.refresh && second.refresh !== first.refresh ? 'rotates' : 'does not rotate'} refresh tokens.`)

const vaultToken = execFileSync('az', ['account', 'get-access-token', '--resource', 'https://vault.azure.net', '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
await saveSecret(VAULT, 'GREENPLATE_REFRESH_TOKEN', refresh, fetch, vaultToken)
console.log(`Saved to ${VAULT} as crew-greenplate-refresh-token. Restart the crew service to use it.`)
