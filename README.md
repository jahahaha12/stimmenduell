Vibe Together

A browser party game for dubbing movie scenes together, based on the principle of Choicer Voicer. It runs entirely in the browser, is free, and supports mixed PC and mobile play (crossplay).

HOW A GAME WORKS

The host (PC) creates a room and loads a dub pack (GameBanana, Choicer Voicer format) into the lobby.
Players join via room code or QR code (phone or PC, microphone required).
Everyone is assigned characters (for example, one player gets Brian, another gets Peter) and records independently and at their own pace. Anyone who finishes waits and can see the other players’ progress.
For each line there is a still image and these buttons:
Original: the scene with the original audio, with the text shown on screen.
Record: the scene muted, and you speak your lines.
My Take: your take together with the muted scene.
Next / ◀: next or previous line.
When everyone is done, the main screen plays the complete scene with your voices. Watch it as often as you like, then return to the lobby.
The premiere starts for everyone at the same time. The host can replay it for everyone with “Watch again”; with the small orange button, the host can also watch it on their own screen only. Every player can save the result as a video (MP4) or just the audio (WAV).

More players than characters: the lines are split among all players. Fewer players: one player speaks several characters.

DUB PACK FORMAT

A ZIP or folder containing _pack_info.ini, dub_video.ogv (or mp4/webm), and for each line an audio file plus an .ini or .txt file (text, timestamps, character) plus a still image. Optional: _backing_track and icon.png. Packs are stored in the browser (IndexedDB); nothing is uploaded. You load the pack into the lobby as a ZIP or folder (drag the file in or select it).

VIDEO NOTE

Chrome and Edge no longer play Ogg/Theora (the pack format) natively. For this reason, Vibe Together automatically loads a bundled software decoder (ogv.js, public/vendor/ogv). The video always stays muted; the audio comes from the game. The duration of unknown videos is estimated from the lines. On weak phones, software decoding can stutter; in that case the game keeps showing the still image and the progress bar.

RUNNING LOCALLY

node server.js (Node.js 18+, then open http://localhost:3000)

Phones need HTTPS for the microphone. The easiest way: upload the contents of public/ to GitHub Pages, Netlify, or Cloudflare Pages. The connection uses WebRTC (PeerJS, public signaling server, see public/js/config.js). On some mobile networks, a TURN server is also required.

TROUBLESHOOTING

Microphone blocked: the page was not opened via HTTPS.
Room not found: check the code; the host must stay open.
Video missing on phone: the still image and audio still work.
Voice slightly out of sync: Bluetooth headphones on a phone add delay.

LICENSES

Vibe Together itself is licensed under the PolyForm Noncommercial License 1.0.0 (see LICENSE): using, modifying, and sharing is allowed for noncommercial purposes, meaning private use, with friends, for learning, or for hobby projects. Commercial use (selling, advertising or payment models, integration into a commercial product) is not allowed without the author’s permission. The license text and copyright notice must be retained in copies. The bundled libraries have their own licenses:

PeerJS (MIT), JSZip (MIT), qrcode-generator (MIT), ogv.js (MIT, licenses in public/vendor/ogv), mp4-muxer (MIT, public/vendor/mp4-muxer.LICENSE), RNNoise (BSD-3, see below). Pack contents belong to their creators; only use material you have the rights to. Independent fan project.

NOISE SUPPRESSION

Background noise filtering uses RNNoise (BSD-3, Xiph/Mozilla) as WebAssembly in public/vendor/rnnoise/. It is on by default; each player can turn it on or off themselves in the lobby and in the game (applies per device). Licenses: public/vendor/rnnoise/NOTICE.txt.

LANGUAGES

At the top right of the start page (and when joining) there is a language selector: Deutsch, English, Español, Français, Português, Русский, and हिन्दी. Each device sets its own language. Without a selection, the game uses the browser’s language (otherwise English). The German texts are in the code; the other languages are in public/js/lang/ (one file per language). To add another language: create a file modeled on en.js, and add it in public/js/i18n.js (the LANGS list) and in public/index.html. The subtitle translation below the text runs in the selected language.

PREFERRED ROLE AND TRANSLATION

In the lobby, each player can tap their preferred character (only in “Random” mode; the host can turn this on or off with the “Allow preferred role” switch). A player who picks a preferred role gets that character in full (if the number of characters equals the number of players, everyone gets exactly one whole character; with more characters, the rest is distributed fairly). Only if too little would otherwise be left for players without a preference, very large preferred roles are trimmed slightly so that nobody goes empty-handed. Foreign-language subtitles automatically get a translation into the selected language on each device via the free MyMemory service (api.mymemory.translated.net, daily limit per internet connection). Without internet there is no translation, and the game runs normally.

FOR DEVELOPERS: STRUCTURE AND CUSTOMIZATION

Pure HTML/CSS/JavaScript with no build step: change files, reload the page. All modules hang off the global object VD; index.html loads them in the correct order.

public/js/config.js: Start here. Game name, server, limits (limits) and game feel (game: lead-in/lead-out, recording tail, target volume, wait times).
public/js/scene.js: Core mechanics: pack to scene, role assignment (Scene.assign, including preferred roles) and the final mix (Scene.finalMix).
public/js/host.js: Game flow on the host (lobby, loading, recording, result), player management, messages from phones.
public/js/hostviews.js: All views of the host screen.
public/js/player.js: View and flow on the phone (or on the host PC as a player): original, recording, take, submission.
public/js/net.js: Connection (PeerJS/WebRTC), chunked file transfer.
public/js/audio.js, analysis.js, denoise.js: Microphone, playback, volume leveling, noise suppression.
public/js/video.js, export.js, vcache.js: Video (including the ogv.js fallback), export as MP4/WebM/WAV, video cache on the phone.
public/js/packs.js: Import and storage of dub packs.
public/js/i18n.js, public/js/lang/: Languages (see above).
public/css/style.css: The entire look; colors and spacing as variables at the top of the file.

Messages between host and phone are small objects with a field t (for example hello, scene, take, phase); the receiving side handles them in onPlayerMsg (host.js) or onMsg (player.js). Everything coming from another device is validated there before it is used.

Checking translations: set the language, play through the game, and type VD.missing in the browser console. It lists all texts that are still missing in that language.
