# H3 Live Director

Talk → MiniMax H3 (via ComfyUI) generates a clip per phrase → re-edit the cut → download, or upscale in Topaz Video AI.

```
npm start            # http://localhost:8787  (Node 20+, ffmpeg on PATH, zero npm deps)
npm test             # end-to-end test in mock mode
```

With no `config.json` it runs in **MOCK mode** (test-pattern clips) so you can try the whole flow without a GPU.

## Connect Comfy Cloud
Set `comfyUrl` to `https://cloud.comfy.org` and `apiPrefix` to `/api`, and provide your key as the `COMFY_API_KEY` env var (never commit it). If the server runs in a Claude Code cloud session, add `cloud.comfy.org` to the environment's allowed network domains and `COMFY_API_KEY` to its secrets. For local ComfyUI use `http://127.0.0.1:8188` and `apiPrefix: ""`.
The Cloud paths/headers are modelled on ComfyUI's API and **not yet verified against Comfy's docs or a live account** — first real run may need small tweaks in `lib/comfy.js`. Workflows must only use nodes/models available on Cloud.

## Connect ComfyUI
1. In ComfyUI, build your H3 text-to-video and image-to-video workflows (with your LoRAs / training adapter / distill LoRA), end them in a video-saving node, and use **Save (API Format)**. Put the files in `workflows/`.
2. `cp config.example.json config.json` and set `comfyUrl` plus each workflow's `map` — `[nodeId, inputName]` for `prompt`, `seed`, `width`, `height`, `frames` (and `image` for i2v). Node IDs are the keys in your API JSON.

## How it works
- **Talk**: browser speech recognition (Chrome/Edge) streams text; a pause (default 1.6 s) commits it as a shot. You can also type shots.
- **Generate**: shots queue serially. With *Continue from previous clip* on, shot N starts from shot N-1's last frame (i2v), so the scene flows; otherwise t2v.
- **Re-edit**: edit a shot's prompt and ↻ Redo it (new seed), reorder, mute, trim in/out, delete. *Play cut* previews the edit; *Follow live* auto-plays new clips as they land.
- **Export**: *Download cut* stitches enabled clips (with trims) into one MP4. *Session archive* downloads a `.tar.gz` (clips + `session.json`); *Import…* restores it later to keep editing.
- **Topaz**: set `topaz.ffmpeg` in `config.json` to Topaz Video AI's bundled ffmpeg (the server machine needs Topaz installed and logged in) and *Upscale in Topaz* runs the `tvai_up` filter on the cut. Otherwise download the cut and open it in Topaz.

## Not verified / next up
- Real ComfyUI + H3 and Topaz paths are untested here (no GPU/Topaz in this environment); only mock mode is tested.
- Ideas: LLM rewrite of spoken text into cinematic prompts, H3 audio-driven shots, per-shot LoRA picker, websocket progress instead of polling.
