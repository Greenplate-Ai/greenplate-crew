// Start the crew service: npm run serve. Env: PORT, CREW_APP_TOKEN (required), MODEL_API_KEY,
// GREENPLATE_MCP_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, CREW_CAN_WRITE=1.
// Starts with whatever keys exist: voice only, crew only, or both. GET /health says which.
import { museSpark } from '../fleet/model.js'
import { crewServer } from './server.js'
import { connectKitchen } from './service.js'
import { museSparkEyes, museSparkPlate } from './vision.js'
import { cachedVoice, elevenLabsVoice } from './voice.js'
import { loadKeysFromVault, saveSecret } from './keyvault.js'
import { exchangeCode, greenplateSession } from './greenplate-auth.js'
import { limitedVoice, limiter } from './limits.js'

// On the server, keys come from Azure Key Vault (AZURE_KEYVAULT=<vault name>) into memory only.
if (process.env.AZURE_KEYVAULT) {
  const loaded = await loadKeysFromVault(process.env.AZURE_KEYVAULT)
  console.log(`keys from ${process.env.AZURE_KEYVAULT}: ${loaded.join(', ') || 'none yet'}`)
  if (!process.env.CREW_APP_TOKEN) throw new Error(`Add crew-app-token to ${process.env.AZURE_KEYVAULT}`)
}

const appToken = process.env.CREW_APP_TOKEN
if (!appToken || appToken.length < 24) throw new Error('Set CREW_APP_TOKEN to a long random string (the glasses app sends it).')
const port = Number(process.env.PORT ?? 8787)
const missing: string[] = []
const limits = limiter()

// 'low' for the crew: each kitchen answer is several model turns, and default effort made it 15-30 s.
const model = process.env.MODEL_API_KEY ? museSpark({ effort: 'low' }) : (missing.push('MODEL_API_KEY'), undefined)
const eyes = process.env.MODEL_API_KEY ? museSparkEyes() : undefined
const plate = process.env.MODEL_API_KEY ? museSparkPlate() : undefined
const talker = process.env.MODEL_API_KEY ? museSpark({ effort: 'minimal' }) : undefined
let kitchen: Awaited<ReturnType<typeof connectKitchen>> | undefined
// A signed-in person's kitchen (npm run kitchen-login) wins over a fixed token.
const vault = process.env.AZURE_KEYVAULT
// Every renewed sign-in is saved straight away, so a restart picks up where it left off.
const keep = async (next: string) => {
  if (!vault) return
  await saveSecret(vault, 'GREENPLATE_REFRESH_TOKEN', next)
  console.log('saved the renewed GreenplateAi sign-in')
}
// A sign-in finished from the app ("Connect your kitchen"): keep it, then connect with it.
const connect = async (code: string, verifier: string, redirect: string) => {
  const t = await exchangeCode(code, verifier, redirect)
  if (!t.refresh) throw new Error('GreenplateAi did not return a lasting sign-in (offline_access)')
  await keep(t.refresh)
  return connectKitchen({ token: greenplateSession(t.refresh, keep).token })
}
if (process.env.GREENPLATE_REFRESH_TOKEN) {
  const session = greenplateSession(process.env.GREENPLATE_REFRESH_TOKEN, keep)
  try { kitchen = await connectKitchen({ token: session.token }) } catch (e) { missing.push(`GREENPLATE_REFRESH_TOKEN (rejected: ${(e as Error).message})`) }
} else if (process.env.GREENPLATE_MCP_TOKEN) {
  try { kitchen = await connectKitchen() } catch (e) { missing.push(`GREENPLATE_MCP_TOKEN (rejected: ${(e as Error).message})`) }
} else missing.push('GREENPLATE_REFRESH_TOKEN (connect the kitchen from the app)')
const speak = process.env.ELEVENLABS_API_KEY ? cachedVoice(limitedVoice(elevenLabsVoice(), limits)) : (missing.push('ELEVENLABS_API_KEY'), undefined)

crewServer({ model, talker, kitchen, connect, eyes, plate, speak, missing, canWrite: process.env.CREW_CAN_WRITE === '1', appToken, limits })
  .listen(port, () => console.log(`crew service on :${port}; missing: ${missing.join(', ') || 'nothing'}`))
