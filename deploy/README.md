# Running the crew service

The service starts with whatever keys it has and says what's missing at `GET /health`:
voice only (ElevenLabs), crew only (Meta + GreenplateAi), or both.

## On the home server (i2-ci-1)

```
ssh i2-ci-1
git clone https://github.com/Greenplate-Ai/greenplate-crew.git && cd greenplate-crew
cp deploy/env.example deploy/.env && nano deploy/.env     # paste keys here, on the server
docker compose -f deploy/compose.yml up -d --build
curl http://localhost:8787/health
```

In the iPhone app, Settings: the service address and the same `CREW_APP_TOKEN`.

## Reaching it from the phone

- At home: `http://192.168.1.7:8787` works on the same Wi-Fi (the app allows local-network HTTP).
- Anywhere (store, demo): a Cloudflare Tunnel gives an HTTPS address with no open ports, e.g.
  `https://crew.i2systems.ai`. Free.

## Picking a voice

```
ELEVENLABS_API_KEY=... npm run voice-sample -- <voiceId> "Green onions, checked off."
```

Writes `voice-<voiceId>.mp3`. Put the chosen ID in `ELEVENLABS_VOICE_ID`.
