# Remote Enter

Press Enter on your Windows PC from a web page.

## Server (Coolify)
1. Push this repo to Git and add it in Coolify as an app with the **Dockerfile** build pack.
2. Port: `3000`. Health check: `/healthz`.
3. Assign a domain (HTTPS).

## Client (Windows)
1. Copy the `client` folder to the PC.
2. Edit `enter-client.ps1` and set `$Server` to your Coolify URL.
3. Double-click `start.bat`. It prints a Client ID and a link.
4. Open the link (or paste the ID on the web page) and press the button.

Enter goes to whichever window has focus. The ID is saved in `client/client-id.txt`; delete that file to get a new ID (this revokes the old one).
