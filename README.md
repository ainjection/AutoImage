# Auto Image Flow

A Chrome extension that batch-generates images from a JSON of prompts using Google Flow,
and files each result neatly into per-scene folders. Built with [WXT](https://wxt.dev/) + React.

## Why

Generating many images one-by-one (for shorts, slides, thumbnails, social content) is slow,
and image APIs get expensive fast. Auto Image Flow automates the manual steps in Flow —
type prompt → generate → download — so you can run a whole batch from one JSON file.

## Install (developer mode)

1. `npm install`
2. `npm run build`
3. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `.output/chrome-mv3`.

## Use

1. Open Google Flow, sign in, set it to generate **1 image per prompt**.
2. Keep the Flow tab active. Click the extension.
3. Upload a `script.json` and click **Start Generation**.
4. Images download to `Downloads/Auto_Image_Flow/Scene_01/image_1.jpg`, etc.

### JSON format

```json
{
  "scenes": [
    {
      "scene_number": 1,
      "image_prompt": {
        "subjects": [{ "description": "...", "action": "..." }],
        "environment": "...",
        "lighting": "...",
        "composition": "...",
        "style": "..."
      }
    }
  ]
}
```

## Notes

- Processes one scene at a time and assigns new image tiles to the current scene in order —
  robust, no dependency on Flow's internal API.
- Paces generations and cools down automatically if Flow rate-limits.
- Reference-image support is on the roadmap.

## Credits

Inspired by hans1801's Flow-automation concept (seen in a YouTube tutorial). This is an
independent, from-scratch implementation.

## License

MIT — see [LICENSE](./LICENSE).
