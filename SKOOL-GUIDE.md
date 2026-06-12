# AutoImage — How To Use

Generate a whole batch of AI images from a list of prompts, automatically, using Google Flow
(Nano Banana 2) — at **0 credits**. AutoImage types each prompt, generates, downloads, and files
the result into a per-project folder, so you're not sitting there making them one at a time. It
also has a **Video mode** (Omni text-to-video) that's semi-automatic.

---

## What you need

- Google Chrome
- A Google account with access to **Google Flow** (labs.google)
- 5 minutes to install
- *(Optional)* Claude or ChatGPT to write your prompts file — by far the easiest way

---

## Part 1 — Install it (one time)

You have two ways to get the extension:

**A. Easiest (non-coders):** download the prebuilt extension folder from this lesson and unzip it.

**B. From GitHub:** the code is at `github.com/ainjection/AutoImage`. Paste that URL into Claude
or ChatGPT and say *"clone this and build it, then tell me the folder to load in Chrome."* (Under
the hood it's `npm install` then `npm run build`, which creates a `.output/chrome-mv3` folder.)

Then load it:

1. Go to `chrome://extensions`
2. Turn **Developer mode** ON (top-right toggle)
3. Click **Load unpacked**
4. Select the **`.output/chrome-mv3`** folder
5. Pin it: click the puzzle-piece icon in Chrome's toolbar → pin **AutoImage**

---

## Part 2 — Set up Google Flow

1. Open **labs.google** (Flow) and sign in.
2. For images, set Flow to:
   - Model: **Nano Banana 2**
   - Aspect ratio: whatever you need (e.g. **16:9**)
   - **1 image per prompt**
3. **Keep the Flow tab open and active** while it runs. If you click away or close a panel,
   re-set those settings — Flow forgets them.

---

## Part 3 — Make your prompts file (JSON)

Easiest path: ask Claude or ChatGPT — *"Make me an AutoImage JSON with 6 scenes about ___"* — and
give it one of these formats.

**Images (structured — best for keeping a character consistent):**

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

**Images (simple — one plain prompt per scene):**

```json
{ "scenes": [ { "scene_number": 1, "prompt": "a red sailboat at golden hour, cinematic" } ] }
```

---

## Part 4 — Generate images (fully automatic)

1. Be on the Flow tab, then click the **AutoImage** icon.
2. Toggle to **🖼️ Images**.
3. **Upload your prompts JSON** — it confirms *"✓ filename — N scenes detected"*.
4. Type a **Project name** — that becomes the folder.
5. Click **Start Generation**. *(Clear Queue resets everything.)*
6. Walk away. It types each prompt, generates, downloads, and moves to the next. Watch the
   **Overall Progress** bar.
7. Your images land in:
   `Downloads\AutoImage\<YourProject>\scene_01.jpg`, `scene_02.jpg`, … — filed by scene, ready to
   drop into CapCut or any editor.

**Status key:** ⏳ pending · ⚙️ generating · ✅ downloaded · 🐢 rate-limited (it cools down and
retries on its own) · ❌ error.

---

## Part 5 — Generate video (semi-automatic)

Video mode uses Flow's **Omni** text-to-video model. It's *semi*-automatic for one reason: Flow's
download button only appears on hover, and a Chrome extension can't fake a real mouse hover. So
you do **one download click per clip** — everything else runs itself.

1. In **Flow**, switch to **Video**, choose the **Omni** model, set your aspect (e.g. 16:9) and
   length. *(Omni does up to 10s. Roughly 7 credits for ~5s, 15 for 10s. Video uses Flow credits —
   this part is not free.)*
2. In AutoImage, toggle to **🎬 Video** and upload a video JSON:
   `{ "scenes": [ { "scene_number": 1, "prompt": "your shot description" } ] }`
3. Set a **Project name** → **Start Generation**.
4. When a clip finishes, the popup shows a purple **"⬇️ A clip is ready"** banner. In Flow:
   click the **⋮** on that clip → **Download → 720p** (or higher).
5. AutoImage renames it to `Downloads\AutoImage\<YourProject>\scene_01.mp4` and **auto-advances**
   to the next prompt. One click per clip, that's it.

So you can queue 10+ prompts (even a whole script), and just click download as each one lands.

---

## Tips & gotchas

- **Keep the Flow tab open** and your settings locked while it runs. Click out → re-set
  model / aspect / 1-image.
- **One image per prompt** is the cleanest setup.
- The **free Flow tier rate-limits** (~8 images/min). AutoImage cools down and continues on its
  own. A paid Google plan gives more headroom.
- **Reference image** is *coming soon* (disabled for now — in testing it barely changed results).
- **Consistency trick:** a tight text description of your character plus a simple style keeps it
  consistent across separate images — perfect for stickman / doodle styles.
- Run **only one** Flow-automation extension at a time (two will clash).

---

## What it costs

- **Images** via Flow → **0 credits**.
- **Video** (Omni) → Flow credits (~7 for 5s, ~15 for 10s).

---

*Inspired by hans1801's Flow-automation concept on YouTube — rebuilt from scratch as our own
MIT-licensed code.*
