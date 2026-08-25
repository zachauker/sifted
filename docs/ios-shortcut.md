# Saving recipes from your iPhone

iOS Safari cannot register a web app as a share-sheet target, so this app uses a
Shortcut instead. Setup takes about a minute per phone and only has to be done
once. After that, saving a recipe is: **Share → Save to Sifted**.

## One-time setup, per phone

First, mint a token on the machine that runs the app:

```bash
npm run token -- zach@example.com "Zach's iPhone"
```

It prints once and cannot be recovered. Have it in front of you before you start
building the Shortcut.

Then, on the phone:

1. Open **Shortcuts** and create a new shortcut named **Save to Sifted**.
2. Open its settings (the ⓘ icon) and turn on **Show in Share Sheet**.
3. Set **Accepted Types** to **URLs** only. This keeps it out of the share sheet
   for photos and text, where it would just be noise.
4. Add a **Get Contents of URL** action:
   - **URL:** `https://<your-app-domain>/api/import`
   - **Method:** `POST`
   - **Headers:**
     - `Authorization` → `Bearer <the token you just minted>`
     - `Content-Type` → `application/json`
   - **Request Body:** `JSON`
     - Key `url`, type Text, value **Shortcut Input**
5. Add a **Show Notification** action so you get confirmation rather than
   silence. Set its body to **Contents of URL**.

## Why it confirms instantly

The API returns `202 Accepted` as soon as the job is recorded, then does the
fetching, parsing, image processing, and storage in the background. You get a
confirmation in about a second even on cellular, and the recipe appears shortly
after.

This is deliberate. Fetching a page, extracting it, calling the model, and
processing an image takes five to twenty seconds. Making you watch a spinner for
that — in a grocery aisle, on a bad connection — would be a worse experience than
the Notion clipper this replaces. And a slow blog would look like a failure when
it is merely slow.

The tradeoff is that "saved" means "queued", not "finished". Failures surface in
the app's needs-attention list rather than in the notification.

## Responses you might see

| Response | Meaning |
| --- | --- |
| `{"status":"queued","jobId":"..."}` | Accepted, working on it. |
| `{"status":"duplicate","recipeId":"..."}` | Already in the library. Nothing was created. |
| `{"error":"unauthorized"}` | The token is wrong, revoked, or the header is malformed. |
| `{"error":"invalid url"}` | The share sheet sent something that is not a URL. |

## Blocked publishers

Some publishers refuse requests coming from datacenter IP addresses. Measured so
far: **Allrecipes** and **Simply Recipes** both return 403 — and they do it even
to a residential IP with a browser user agent, so they are fingerprinting more
than the address.

Those imports land in the needs-attention list marked `blocked`. Recovery is to
open the page in a browser, copy its HTML, and paste it into the retry form —
the server cannot fetch that page, but your browser already has it.

If this turns out to be common, a second Shortcut variant can send the page text
along with the URL: add a **Get Contents of Web Page** action and include an
`html` key in the JSON body. The API already accepts that field, so this is a
Shortcut change only, with no server work.

**This is no longer hypothetical.** Both measured publishers — Allrecipes and
Simply Recipes — need it, and the needs-attention tray's `blocked` card now
tells people to come here for it: on a desktop browser the recovery is
View Page Source, copy, paste into the retry form, but mobile Safari has no
View Page Source at all, and this is a phone-first app. Build the second
Shortcut variant above — **Get Contents of Web Page** feeding an `html` key
alongside `url` in the same JSON body the first Shortcut sends — and use it
in place of **Save to Sifted** for anything from a blocked publisher.
Everything else about the setup (the token, the headers, the notification)
is identical to the first Shortcut.

## Replacing or revoking a token

Tokens are per-phone, which is the point: if a phone is lost, revoke only its
token and the other phone keeps working. Issue a replacement with
`npm run token -- <email> "<label>"` and update the header in that phone's
Shortcut.
