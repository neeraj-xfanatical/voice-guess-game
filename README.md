# 🎙️ Whose Voice?

Party game for a Meet call: one random player records an English phrase with a voice filter, everyone listens and votes on whose voice it is.

- One room at a time, up to 25 players and a host
- Join with a 6-character code and a name (saved in localStorage, survives refresh)
- The host and co-hosts run the game. They are never picked and do not vote
- The recorder chooses one of 3 random phrases (or shuffles for new ones), picks a filter (Chipmunk, Radio, Alien, Ghost, or No filter for the real voice), listens to the clip, re-records if needed, then sends (max 20 s clip, 90 s for the whole recording phase)
- ~100 office-friendly default phrases in `server/phrases.js`; the host can add more
- Players can practise with the Voice test card between rounds (local only, never uploaded)
- After the game, everyone can replay every round's clip. The host/co-host browser also keeps a copy in IndexedDB until a new game starts or the room is closed
- Voice filters run in the browser, so with a filter the real voice never reaches the server (No filter sends the real voice)
- No database. All game data is kept in server memory
- Results are also saved in the host/co-host browser (`/results`, CSV download)
- Works on Chrome and Brave on Windows desktop

## Guess the Teammate (second game)

The host can switch the room between **Whose Voice?** and **Guess the Teammate** in the Controls panel (between rounds). Both games share the room, players and scoreboard.

- The host shows the riddles one by one, in the order of `server/riddles.js`
- Every player picks the teammate's name from a list. One answer per riddle, no changing it
- Correct answer: +10 points, plus up to +5 for answering fast. The fastest correct player is shown as the winner of that riddle
- After everyone answers (or time runs out, 45 s by default, changeable in Settings) the answer is revealed with the teammate's photo
- At the end the scoreboard shows the overall winner and every riddle's answer

**Setup:** open `server/riddles.js`, write each teammate's name in `answer`, put their photo in `public/photos/` and write the file name in `photo`. Restart the server. Riddles with no answer are skipped. A riddle with no photo shows the person's initials. The answer and photo are only sent to players at the reveal. Photos committed to the repo are public if the repo or the site is public.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # automated game-flow test
```

## Run with Docker

```bash
docker compose up --build      # http://localhost:3000
```

## Deploy (Render, free plan)

1. Push this folder to a GitHub repo.
2. On Render, create a **New → Web Service** from that repo. It detects the `Dockerfile`.
3. Set **Health Check Path** to `/health`.
4. Open the site once before playing. The free plan sleeps after ~15 minutes idle, and a sleeping server loses the room.

The mic only works on `https://` or `localhost`. Render gives you HTTPS.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Server port |
| `MAX_PLAYERS` | 25 | Max people besides the host |
| `RECORD_PHASE_SECONDS` | 90 | Total time for the recorder |
| `MAX_CLIP_SECONDS` | 20 | Max recording length |
| `DEFAULT_VOTE_SECONDS` | 30 | Voting time (host can change it in the game) |
| `DEFAULT_RIDDLE_SECONDS` | 45 | Time to answer a riddle (host can change it in the game) |
| `RIDDLES_FILE` | `server/riddles.js` | Use a different riddle file |
| `ROOM_IDLE_MINUTES` | 30 | Close the room after this long with nobody connected |
| `RECORDER_OFFLINE_SECONDS` | 20 | Skip the round if the recorder is offline this long |
| `RECLAIM_AFTER_SECONDS` | 15 | Someone who lost their session can join again with the same name after their seat has been offline this long |

## Structure

```
server/index.js    Express REST API + Socket.io events
server/game.js     Room and game logic (in memory)
server/phrases.js  Default English phrases
server/riddles.js  Guess the Teammate riddles, answers and photo file names
public/photos/  Teammate photos
public/            Pages: index (home), room (game), results
public/js/audio.js Recording, Tone.js filters, WAV encoding
test/smoke.js      End-to-end test of the game flow
```
