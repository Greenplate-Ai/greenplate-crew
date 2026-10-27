// Hear a voice before choosing it: npm run voice-sample -- <voiceId> ["text"] -> voice-<voiceId>.mp3
import { writeFileSync } from 'node:fs'
import { elevenLabsVoice } from './voice.js'

const [voiceId, text] = process.argv.slice(2)
if (!voiceId) throw new Error('usage: npm run voice-sample -- <voiceId> ["text"]')
const audio = await elevenLabsVoice({ voiceId })(text ?? 'You need green onions, rice and limes. Everything else for this week is already at home.')
writeFileSync(`voice-${voiceId}.mp3`, audio)
console.log(`wrote voice-${voiceId}.mp3 (${audio.length} bytes)`)
