# Glasses won't connect: check these before touching code

Meta's own toolkit decides which glasses a third-party app may use. When it refuses, no app code
change fixes it. Check the glasses and the Meta AI app first, in this order:

1. **Developer Mode is on for this pair.** Meta AI app → Settings → App Info → tap the version 5
   times → Developer Mode on. It is per pair of glasses, and it switches itself off after a
   firmware update or a factory reset.
2. **Kitchen Crew is the registered developer app.** Meta AI → App connections → Developer mode
   apps should list Kitchen Crew. Only one third-party app can be registered in Developer Mode at a
   time: registering another one silently removes Kitchen Crew (Meta, "Permissions requests").
   If it isn't listed, register from Kitchen Crew's Glasses tab.
3. **Then tap Connect once and read the service log** (`app connect_failed` / `session_states`).

What the errors mean:

| Log / screen | Meaning |
|---|---|
| "No usable glasses" (`noEligibleDevice`) | Meta won't give this app a session on any connected pair: steps 1-2 |
| "The glasses ended the session" right after start | Same refusal when the app names the pair itself |
| "Glasses are off or not connected", empty device report | Meta AI sees no glasses at all: power, Bluetooth, case |

## 2026-10-30: what happened

The Ray-Bans connected and worked 11:00-13:48 on build 146. They were factory-reset that evening,
which wiped Developer Mode and the registration, and every connect after that was refused. Builds
147-153 changed screens, logging and the device selector; none of them could fix it, because the
cause was on the glasses. The connection code had not changed since build 146.

## Rules for the next change

- No new build for a connection problem until a connect attempt made after steps 1-2 has been read
  in the log.
- Every fix names the log line or Meta doc line it rests on before a build is cut. A build costs
  about 15 minutes of the tester's time.
- Known open app bug, to fix only after a passing connect: when connects fail, retries come about
  once a second instead of backing off.
