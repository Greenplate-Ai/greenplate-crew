// Start the crew service: npm run serve (PORT, CREW_APP_TOKEN, MODEL_API_KEY, GREENPLATE_MCP_TOKEN).
import { museSpark } from '../fleet/model.js'
import { crewServer } from './server.js'
import { connectKitchen } from './service.js'
import { museSparkEyes } from './vision.js'

const appToken = process.env.CREW_APP_TOKEN
if (!appToken || appToken.length < 24) throw new Error('Set CREW_APP_TOKEN to a long random string (the glasses app sends it).')
const port = Number(process.env.PORT ?? 8787)

const kitchen = await connectKitchen()
crewServer({ model: museSpark(), kitchen, eyes: museSparkEyes(), canWrite: process.env.CREW_CAN_WRITE === '1', appToken })
  .listen(port, () => console.log(`crew service on :${port}`))
