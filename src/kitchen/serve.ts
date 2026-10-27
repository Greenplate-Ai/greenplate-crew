// Start the crew service: npm run serve. Env: PORT, CREW_APP_TOKEN (required), MODEL_API_KEY,
// GREENPLATE_MCP_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, CREW_CAN_WRITE=1.
// Starts with whatever keys exist: voice only, crew only, or both. GET /health says which.
import { museSpark } from '../fleet/model.js'
import { crewServer } from './server.js'
import { connectKitchen } from './service.js'
import { museSparkEyes } from './vision.js'
import { elevenLabsVoice } from './voice.js'

const appToken = process.env.CREW_APP_TOKEN
if (!appToken || appToken.length < 24) throw new Error('Set CREW_APP_TOKEN to a long random string (the glasses app sends it).')
const port = Number(process.env.PORT ?? 8787)
const missing: string[] = []

const model = process.env.MODEL_API_KEY ? museSpark() : (missing.push('MODEL_API_KEY'), undefined)
const eyes = process.env.MODEL_API_KEY ? museSparkEyes() : undefined
let kitchen: Awaited<ReturnType<typeof connectKitchen>> | undefined
if (process.env.GREENPLATE_MCP_TOKEN) {
  try { kitchen = await connectKitchen() } catch (e) { missing.push(`GREENPLATE_MCP_TOKEN (rejected: ${(e as Error).message})`) }
} else missing.push('GREENPLATE_MCP_TOKEN')
const speak = process.env.ELEVENLABS_API_KEY ? elevenLabsVoice() : (missing.push('ELEVENLABS_API_KEY'), undefined)

crewServer({ model, kitchen, eyes, speak, missing, canWrite: process.env.CREW_CAN_WRITE === '1', appToken })
  .listen(port, () => console.log(`crew service on :${port}; missing: ${missing.join(', ') || 'nothing'}`))
