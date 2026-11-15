# PINGVERSE VR

First-person, hand-tracked table tennis for Meta Quest, built on the Meta Immersive Web SDK (IWSDK), WebXR and three.js, in TypeScript.

You stand (or sit) at one end of a regulation table, pick up a paddle with your bare hand, and play. The paddle follows your tracked hand; its real position, angle and velocity decide every shot.

## Run it

Requires Node.js 20.19+ (developed on Node 26).

```bash
npm install
npm run dev        # game on https://<this-pc-ip>:8081  (self-signed HTTPS, needed for WebXR)
npm run server     # optional: multiplayer + rankings server (ws://localhost:8787, proxied at /ws)
```

**On the Quest:** put the headset on the same Wi-Fi as this PC, open the Meta Quest Browser, go to `https://<this-pc-ip>:8081`, accept the certificate warning (Advanced > Proceed), then press **Enter VR**. Allow hand tracking when asked and put the controllers down.

**On a desktop browser** (no headset) you get a preview: the mouse moves the paddle, clicks press menu buttons.

Other commands:

```bash
npm test           # physics, rules, AI-vs-AI and multiplayer-server tests (no browser needed)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
npm run build:humans  # regenerate public/models/*.glb from MakeHuman's CC0 assets (downloads ~60 MB once)
```

## Playing with your hands

| Action | How |
| --- | --- |
| Press a menu button | Poke it with an index fingertip |
| Pick up the paddle | Close your hand around the handle of the hovering paddle (or menu: *Hold paddle*) |
| Serve | Rest the ball on your open free hand and lift to toss it, then strike it. With one hand tracked the ball tosses itself on a steady rhythm |
| Pause / recenter / replay / scoreboard | Hold a fingertip on the small button strip beside the table for a moment |
| Adjust grip, table distance, height, reach | Main menu > *Comfort & Grip* |

Controllers also work as a fallback (grip pose drives the paddle), but nothing requires them.

## What is in the game

- **Table**: regulation 2.74 x 1.525 m at 0.76 m, lines, net with posts and clamps, undercarriage. Five designs.
- **Physics** (`src/physics`): fixed 600 Hz timestep; gravity, quadratic drag, Magnus lift, spin decay; friction-coupled bounces (topspin kicks, backspin holds); swept paddle and net collision so nothing tunnels; edge balls; identical results at any frame rate.
- **Rules** (`src/rules`): 11-point games, two-point margin, 2-serve rotation (1 from 10-10), alternating first server, legal serves, lets, edge balls, volleys, double hits, best of 1/3/5/7.
- **AI** (`src/ai`): four difficulties x four personalities (Defender, Attacker, Strategist, Spin Master). The AI reads the ball with the real flight model, solves for a paddle motion and swings a real paddle through the shared physics, with reaction delay, limited speed and aiming error. It cannot move the ball or the score any other way.
- **Opponent** (`src/render/avatar.ts`, `public/models/player.glb`): a rigged MakeHuman character (CC0, Mixamo bone names, built by `npm run build:humans`) driven on top of its idle/walk/run clips, each avatar at its own slightly shifted tempo. The body shadows the paddle with real footwork, bends knees and waist so the grip stays within the arm's true reach, a two-bone IK solve wraps the hand around the handle, the head follows the ball, and points trigger celebrations, sulks and a few words. Remote players are posed from their tracked head (height included) and free hand; a different personality tints the shirt a different colour.
- **Modes**: Quick Match, Practice (ball machine, serve practice, spin lab, smash, forehand/backhand, targets), Challenges (moving targets, rally streak, serve return, beat the clock, precision), Tournament (8-player bracket; the other fixtures are genuinely played by the AI in the background), Spectator (watch AI v AI), Multiplayer.
- **Multiplayer** (`server/`, `src/net`): WebSocket server with private rooms and room IDs, invite links (`?room=CODE`), quick matchmaking, pose and ball relay, reactions, reconnection with a 45 s grace period, Elo rankings.
- **Venues**: Sports Arena, Luxury Club, Cyber Arena, Training Studio. Procedural, with spatial (HRTF) audio. The arena crowd is a few hundred animated people (`src/render/crowd.ts`: two low-poly MakeHuman bodies with their clips baked to morph targets, drawn as two instanced meshes with a skin-tone atlas and per-person shirt tints) who idle and wave, and all do the same cheer or jump when a point, game or match is won, each at their own slightly shifted, slowly drifting frequency so the stand never moves in lockstep.
- **Extras**: slow-motion replay, trajectory analysis, spin visualisation, shot analysis (ball speed, swing speed, spin, placement), personal records, achievements, daily challenge, match history, paddle customisation (cosmetic only).

## Code map

```
src/core         constants (regulation dimensions), dependency-free math
src/physics      ball flight + collisions, physics world, flight prediction
src/rules        match laws and scoring
src/ai           shot solver and opponent controller
src/game         session (headless match runner) and the game orchestrator
src/paddle       hand tracking -> paddle pose, serve toss
src/render       table, paddle, ball, avatar models
src/env          the four venues
src/audio        procedural spatial audio
src/hud          poke-able panels, scoreboard, menus
src/modes        drills/challenges, tournament
src/net          multiplayer protocol and client
src/features     progress (records, achievements, history), replay
src/custom       cosmetic catalogue
server           multiplayer server
tests            node --test suites
```

`src/core`, `physics`, `rules`, `ai`, `game/session.ts` and `modes` have no renderer dependency, which is why the tests can play whole matches headlessly.

## Known limits

- Doubles is not implemented (singles only).
- Multiplayer has no lag compensation beyond a short grace period for the opponent's stroke; it is intended for LAN or same-region play. The server must be reachable from both headsets.
- "Global" rankings are global to whichever server you run.
- The serve does not enforce the 16 cm toss height or behind-the-end-line position.
