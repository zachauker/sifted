# Product

## Register

product

## Users

Two people, sharing one library, cooking from it. The primary screen is a phone
propped against something on a kitchen counter, read at arm's length, touched
with hands that are wet or floury or holding a knife. A laptop is the secondary
case, used for importing and tidying rather than cooking.

The jobs, in the order they happen:

- **Find the one.** Narrow 150+ recipes to the one you meant, by course, cuisine,
  tag, rating, or whether you've made it. Search when browsing is too slow.
- **Cook from it.** Read ingredients and steps without scrolling past anything
  else, and keep your place while your hands are busy.
- **Record what actually happened.** Rating, made-it status, notes, and the time
  it really took as against the time the publisher claimed.
- **Save from anywhere.** An iOS Shortcut posts a URL in; the import happens
  without a laptop.

## Product Purpose

Sifted takes a recipe URL, separates the recipe from the food-blog narrative
around it, and stores the result with the parts you cook from at the top and the
author's story kept but folded away at the bottom.

It exists to replace a shared Notion database whose web clipper saved whole
articles and whose search stopped being fast enough to use while standing in a
kitchen. Success is that nobody opens Notion for a recipe again, and that finding
and cooking from a saved recipe never requires scrolling past a thousand words
about someone's summer in Liguria.

## Brand Personality

**Dry, precise, unfussy.**

The voice already exists in the README and the code comments, and it is good: it
states what is true, says why a decision went the way it did, and does not sell.
"A third would be surface area with no purpose." That is the register — confident
enough to explain itself, never pleased with itself.

The name is the thesis. Sifting is separating what you want from what came with
it. The interface should feel like the result of that separation: what remains
after the chaff is gone, not a thing decorated to look substantial.

Emotionally the target is **calm competence**. Cooking is already a state with
timers running and things on the heat. The app's job is to be the one surface in
the room that is not demanding anything.

## Anti-references

- **The food blog itself.** The thing this product rescues you from must never
  be the thing it feels like. No autoplay, no interstitials, no story before the
  content, no scrolling past preamble to reach the list.
- **The generic SaaS dashboard.** Gradient accents, hero-metric tiles, identical
  icon-and-heading card grids, tiny uppercase tracked eyebrows above every
  section. Explicitly rejected by the owner.
- **The recipe-app cliché.** Cream-and-serif "artisanal cookbook" styling is the
  most predictable answer to this category and should not be chosen by reflex.
  If warmth appears, it has to be earned by the existing amber identity rather
  than applied as a category default.
- **Chrome that competes with content.** Heavy nav, persistent banners, badges
  and decoration on inactive state.

## Design Principles

1. **The recipe is the page.** Ingredients and steps get the space. Everything
   else — provenance, narrative, metadata, controls — arranges itself around
   them or moves below them. Nothing outranks the thing you are cooking from.

2. **Say the honest thing out loud.** Facet counts, measured-versus-claimed time,
   "no steps were saved with this recipe," which search tier answered. Where the
   app knows something the user would otherwise have to guess, it says it.
   Silence is indistinguishable from a bug.

3. **Built for wet hands and a glance.** Kitchen ergonomics beat desk ergonomics
   where they conflict: readable at arm's length, targets big enough for a
   knuckle, state that survives being ignored for ten minutes.

4. **Restraint is a feature.** No service worker, no virtualization, no scale
   control — each deliberately absent, each with a written reason. Subtraction is
   a valid answer here, and a new element has to argue for itself.

5. **Accessibility comes from real HTML.** Native checkboxes in real fieldsets,
   `<details>` for the fold, uncontrolled inputs where the browser owns the
   state. Reach for ARIA only where the platform genuinely cannot express the
   thing, and write down why.

## Accessibility & Inclusion

- **WCAG 2.2 AA is the floor**, and the existing implementation already clears it
  in most places. A redesign may not trade any of it for appearance.
- **Contrast:** body text ≥ 4.5:1, large text ≥ 3:1, and the same 4.5:1 for
  placeholder text. Light-gray-on-white "for elegance" is a regression, not a
  style.
- **Touch targets ≥ 44×44px**, which the filter rail already enforces with
  `min-h-11`. Kitchen use makes this a functional requirement, not a checkbox.
- **Reduced motion is mandatory.** Every animation added needs a
  `prefers-reduced-motion: reduce` alternative — a crossfade or an instant state
  change.
- **Keyboard and screen reader parity.** Filter values stay in the tab order even
  when they lead nowhere (`aria-disabled`, not `disabled`), and counts are part
  of the accessible name rather than decoration beside it.

## Current Constraints (2026-08-29)

Set by the owner for the in-flight UI modernization:

- **Light theme only.** Dark mode is being removed, not redesigned — the ~146
  `dark:` variants come out.
- **No new dependencies and no new features.** Design tokens and restyling only;
  all existing behavior and tests keep passing.
- **Stays fast and server-rendered.** The recipe page keeps its single client
  boundary. Nothing that forces new hydration into the part you cook from.
