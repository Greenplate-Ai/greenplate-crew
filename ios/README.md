# Kitchen Crew for iPhone

The companion app that connects Meta glasses to the crew. It uses Meta's Wearables Device Access
Toolkit 1.0.1: on-glasses speech for "crew, ...", the capture button to start and end a shopping
trip, the camera at 2 frames a second only during a trip, and the glasses' speakers for answers.

## How it is used

- **Ask:** say "crew, what am I missing for this week?" The answer is spoken back.
- **Approve:** before anything changes in GreenplateAi, the crew asks out loud. Say yes or no.
- **Shop:** press the capture button or say "crew, start shopping." Hold items up as you shop.
  The crew checks them off, says when you already have something at home, and reminds you what
  is left when you say "crew, check out."

## One-time setup

1. Apple Developer: register the App ID `ai.greenplate.crew` with the **Hotspot Configuration**
   capability, then create the app record in App Store Connect.
2. Codemagic: add this repository and run the `crew-ios-testflight` workflow by hand.
3. Install from TestFlight. In the app, open Settings and enter the crew service address and app
   token (`CREW_APP_TOKEN`).
4. Glasses: Developer Mode on in the Meta AI app, then tap **Register** and **Connect** in the app.

"Hey Meta, start Kitchen Crew" needs the app set up in the Wearables Developer Center and a
release channel; until then, open the app and tap Connect.

The Xcode project is generated with XcodeGen from `project.yml` (`xcodegen generate` in this
folder). Frames are sent to the crew service, named, and dropped. Nothing is saved.
