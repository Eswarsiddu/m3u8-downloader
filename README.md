# Stream Downloader

Paste a `master.m3u8` (or individual video/audio links), store it with a name and optional TMDB / IMDb links, and download it in the background with ffmpeg.

- **Video:** the highest-resolution variant only.
- **Audio:** Hindi, English and Telugu only. Any other language is ignored.
- **Output:** one `.mkv` per item with the audio tracks labelled (`hin`, `eng`, `tel`), saved to `DOWNLOAD_DIR`.
- Items are kept in SQLite (`data/downloads.db`). The queue survives restarts; an interrupted item restarts from the beginning.

## Install on Ubuntu

```bash
# Node 20+ and ffmpeg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg build-essential python3
sudo npm install -g pm2

# App
cd cartoon_downloader
npm install --omit=dev
```

Edit `ecosystem.config.js`: set `DOWNLOAD_DIR`, and **set `APP_USER` / `APP_PASSWORD`** if the port is reachable from the internet (without a password, anyone can queue downloads on your server).

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup      # run the command it prints so pm2 starts on boot
```

Open `http://<server-ip>:3000` (open the port in your firewall / security group, or put nginx in front).

Useful: `pm2 logs stream-downloader`, `pm2 restart stream-downloader`.

## Using it

1. **Paste the whole master.m3u8** into the top box. The video URL and Hindi/English/Telugu audio URLs fill in automatically.
   Or skip that and type the video URL and add audio rows by hand.
2. Enter a **name**, or paste a **TMDB link** and the name fills in as `Title (Year)`. No key is needed: themoviedb.org blocks scripted page fetches, so the name comes from Wikidata (looked up by the TMDB id), and if that has no entry it is guessed from the link text. For the most complete results, set `TMDB_READ_KEY` (your v4 "API Read Access Token") and/or `TMDB_API_KEY` (your v3 "API Key") from themoviedb.org/settings/api. The read token is tried first, then the API key, then Wikidata. IMDb links are stored but not looked up.
3. **Add & start download** queues it now; **Save only** stores it so you can start it later.

## Notes

- **Links expire.** The tokens in these URLs (`e=32400`, about 9 hours) stop working after a while. Start downloads soon after copying them. A failed item needs fresh links, so delete it and add it again.
- If the host returns 403, set **Advanced → Referer** to the site that embeds the player.
- Configuration (environment variables): `PORT` (3000), `HOST` (0.0.0.0), `DOWNLOAD_DIR`, `DATA_DIR`, `MAX_CONCURRENT` (1), `TMDB_READ_KEY`, `TMDB_API_KEY`, `APP_USER` (admin), `APP_PASSWORD`, `FFMPEG_PATH`.
- Keep pm2 at a single instance. The download queue lives in the process.
- Only download content you have the right to.

## Tests

```bash
npm test
```
