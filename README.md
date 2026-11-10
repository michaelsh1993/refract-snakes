# Refract Snakes and Ladders

Climb the ladders, mind the snakes. A complete Refract activity: up to four players race to square 100 on a shared board, with live rolls, spectators, scores, and rematches. It also works on its own against computer opponents or in pass-and-play mode.

**No game server. No account setup. No runtime dependencies.** Refract supplies identities and relays messages; this app supplies the game.

It is built on the activity tooling from [refract-tack-toe](https://github.com/Celzor/refract-tack-toe): the same postMessage bridge, dev server, public-file build, protocol simulator, and Pages workflow.

## Try it locally

With **Node.js 24 or later**:

```sh
npm run dev
```

No `npm install` is needed. Open:

- **[The game](http://127.0.0.1:4173/)** — play against one to three computer opponents, or choose pass & play for two to four people.
- **[Shared activity preview](http://127.0.0.1:4173/tools/preview.html)** — real game frames connected through a local simulation of Refract’s host protocol. Add up to five participants, refresh a player, change themes, leave/rejoin, or start a new session.

For another port: `npm run dev -- --port 4200`. Opening `index.html` directly as a `file:` URL will not load browser modules; use the local server.

## Play in Refract

1. Publish the app at its own **HTTPS origin**, different from your Refract instance. GitHub Pages setup is below.
2. As an instance admin, open **Manage instance → Activities** and add:

   | Field | Value |
   | --- | --- |
   | Name | Snakes and ladders |
   | URL | Your final hosted page URL, including its repository path if applicable |
   | Description | Climb the ladders, mind the snakes. Up to four players, live rolls, and room for spectators. |

3. Reload Refract so its content security policy picks up the activity origin.
4. Join a voice channel or private call. Open **Activities** in the call panel and select **Snakes and ladders**.
5. Have at least one more person join the activity. The first four participants receive a token; everyone else watches.

For development, register `http://127.0.0.1:4173/` on a non-production Refract instance or one with developer mode enabled. Each browser must be able to reach that address: a loopback URL points to the machine running that browser, so use HTTPS hosting for friends on other machines.

The URL must be its final origin; redirects to another domain break Refract’s origin checks. Hosting must allow framing by your Refract instance. If you configure `CSP_DIRECTIVES` manually in Refract, include the activity origin in `frame-src`.

## Publish on GitHub Pages

The included [workflow](.github/workflows/pages.yml) checks the JavaScript, runs the tests, builds a public-only `dist/`, and deploys it when changes reach `main`. Pull requests run checks without deploying.

1. Push this project to a repository.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Run **Check and deploy Pages** from Actions, or push to `main` after enabling Pages.
4. Copy the deployed URL from the workflow and register it in Refract.

All asset URLs are relative, so repository subpaths work.

Alternatively, run `npm run build` and serve **only `dist/`** from any static HTTPS host. Never deploy the whole working directory. The build has an explicit public-file allowlist; tests, tooling scripts, and local configuration stay out of the output.

## Rules

- Everyone starts off the board. Roll the die and move that many squares; first to square 100 wins the round.
- Landing on the foot of a ladder climbs to its top. Landing on a snake’s head slides down to its tail.
- Click **Roll the dice** and the die appears in the middle of the screen. Grab it and fling it, or click anywhere else to toss it; it bounces off the edges of the screen before it lands. The throw is for show: every roll is an independent fair throw. Escape puts the die back; with reduced motion one click rolls straight away.
- **Calm effects** is a per-viewer switch that stops flashing, twinkling, falling snow and the die's flickering faces. It is remembered in that browser and never shared.
- A six earns another roll.
- The last square needs an exact roll. A roll that would overshoot leaves the token where it is.
- Seven ladders and eight snakes are fixed in [`src/game.js`](src/game.js); edit `LADDERS` and `SNAKES` to change the board. The drawing follows the data.

## Game behavior

- First participant coordinates the shared state; only that copy accepts rolls and publishes snapshots.
- **The coordinator throws the die for everyone.** A guest sends a roll request, never a number, so a guest cannot choose its own roll. Requests are validated against Refract’s relayed sender ID, seat, turn, round, and revision. Spectators cannot roll or request rematches.
- First four participants occupy the seats. A later arrival takes an empty seat straight away and starts from square zero; nobody else’s progress changes.
- When a player leaves, their token leaves the board, the turn passes on if it was theirs, and the earliest spectator takes the seat from square zero. With fewer than two players the game waits.
- Host departure hands coordination to the earliest remaining participant and the round carries on from that participant’s copy of the board.
- Completed rounds offer **Next round** to any seated player. The opening seat rotates each round. Scores stay with the **seat**, including when someone new takes it. A seat change after a finished round starts the next one.
- Late arrivals explicitly request a snapshot. A small periodic resync recovers missed messages; participants can also use **Resync game**.
- Snapshots are stored in each frame’s `sessionStorage`, scoped by session ID and user, to survive reloads. If the host reloads with storage unavailable, peers converge on its fresh board. This is an in-call game, not durable match history.
- New Refract session IDs create independent matches. Names are rendered as text. No Refract credentials or tokens are requested.
- Four board themes, shared by the whole game: anyone in the activity, spectators included, can switch it from the **Board** picker, and the change goes through the coordinator like any other move. A viewer's last pick is remembered in their browser and starts any game they host or play locally: **Classic** (follows the host’s light/dark theme), **Christmas** (candy-cane snakes in Santa hats, gold ladders, fairy lights, falling snow), **Jungle** (python-patterned snakes with flicking tongues, bamboo ladders, leaves and vines), and **Space** (neon serpents, light-beam ladders, a ringed planet and twinkling stars). The theme survives rounds, reloads, and host changes. The coordinator takes at most one theme change a second, and theme changes never void or replay a roll.
- Host light/dark theme, reduced-motion preferences, mobile layouts, a described board for assistive technology, and a leave action are supported.

This is a cooperative casual-game protocol, not an anti-cheat service: the coordinating participant’s browser is trusted to publish state and to roll fairly. There is no backend game referee.

## How the integration works

The wire contract is **`refract-activity/1`**. This repository uses the small, dependency-free [bridge](src/bridge.js) from the showcase, so the app does not need a local SDK checkout or a published SDK package.

```text
Activity frame       Refract host         Other participants
      ready ────────────► │
            ◄──── init   │  self, participants, sessionId, theme
      broadcast ────────►│──── message ───────────►
            ◄── message │◄──── broadcast ─────────
```

Incoming browser messages must originate from the framing window; a valid initialization pins that window’s origin. Messages within the activity use `refract-snakes-and-ladders/1`, the Refract session ID, and the elected host ID. Snapshots also carry the ordered membership list. State from a foreign sender, session, or roster is rejected, as is any board that is not internally consistent.

Refract does not echo the sender’s broadcast or retain history. The coordinator applies its own changes locally, and other participants request a snapshot on initialization. Payloads remain below the 16 KiB protocol limit.

| File | Responsibility |
| --- | --- |
| [`src/game.js`](src/game.js) | Pure rules: board, rolls, seating, rounds, and state validation |
| [`src/session.js`](src/session.js) | Seats, authoritative rolls, sync, rematches, and host changes |
| [`src/bridge.js`](src/bridge.js) | Refract postMessage boundary (unchanged from the showcase) |
| [`src/app.js`](src/app.js) | Board drawing, token animation, practice modes, and integration wiring |
| [`tools/preview.html`](tools/preview.html) | Multi-frame Refract protocol simulator |
| [`tests/`](tests/) | Game, synchronization, bridge, and static-serving checks |

## Development checks

```sh
npm run check
npm test
npm run build
```

The unit/integration suite uses Node’s built-in runner and an in-memory relay with a scripted die, without a real Refract account. In environments that forbid child processes, run `node --test --test-isolation=none` instead.

The showcase’s optional Playwright smoke test (`tools/browser-check.mjs`) is not ported. A protocol simulator verifies the app’s side of the contract; final end-to-end acceptance uses two signed-in users in an actual Refract call.

## License

GNU GPL v3, the same as the showcase it derives from. See [LICENSE](LICENSE).
