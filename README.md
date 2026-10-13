# Remote Enter

Press Enter on your Windows PC from a web page, and get a phone notification when a Dota match is ready to accept.

## Server (Coolify)
1. Add this repo in Coolify as an app with the **Dockerfile** build pack.
2. Port: `3000`. Health check: `/healthz`.
3. Add **Persistent Storage** mounted at `/app/data` (keeps push keys and subscriptions across redeploys).
4. Optional: set `VAPID_SUBJECT=mailto:you@yourdomain.com`.

## Client (Windows)
1. Copy the `client` folder to the PC and double-click `start.bat`.
2. It prints a Client ID and a link. Open the link on your phone.
3. Tap **Enable notifications**. On iPhone, first do Share > Add to Home Screen and open it from there.

### Teach it the Accept button (once)
Detection only looks at the screen. The next time a match pops while you're at the PC:
hover the **ACCEPT** button, press **F8**, then move the mouse off the button within 2 seconds.
It saves `calibration.png` (check it shows the button) and from then on watches that spot.

- Redo it (F8 again) if you change resolution, window size, or monitor.
- Dota must be visible on screen (not minimized). Borderless windowed is most reliable.
- If detection misses or misfires, set `$ShowScores = $true` in `enter-client.ps1` to see the scores and adjust `$Threshold`.

Enter goes to whichever window has focus. The ID is saved in `client/client-id.txt`; delete it to get a new ID.
