/**
 * What a recipe with no photo looks like.
 *
 * A meaningful slice of the migrated library arrived from Notion bodies
 * rather than from a publisher's page, and those have no hero image — so
 * this is not a rare edge case to leave as a grey rectangle. The tile
 * carries the recipe's own title in display type over a colour derived from
 * that title, which means the same recipe always looks the same and a card
 * you have seen before is recognisable at a glance in a grid of 156.
 *
 * It is `aria-hidden` on purpose: everything in it duplicates the card's own
 * title text, and a screen reader announcing the title twice per card is
 * worse than a card with no picture.
 */
function hueFor(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 3600
  }
  return hash / 10
}

export function PhotoFallback({ title }: { title: string }) {
  const hue = hueFor(title)

  return (
    <div
      aria-hidden="true"
      data-testid="photo-fallback"
      className="relative flex h-full w-full flex-col justify-end overflow-hidden p-3"
      style={{
        backgroundImage: `linear-gradient(150deg, hsl(${hue} 52% 88%), hsl(${(hue + 40) % 360} 44% 74%))`,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        className="absolute top-2 right-2 h-6 w-6 opacity-30"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <path d="M4 3v7a2 2 0 0 0 4 0V3M6 10v11" />
        <path d="M17 3c-1.5 2-2 4-2 6.5S16 13 17.5 13H19V3z" />
        <path d="M18 13v8" />
      </svg>
      <span
        className="line-clamp-3 font-serif text-base leading-tight font-medium text-black/70"
        style={{ color: `hsl(${hue} 55% 22%)` }}
      >
        {title}
      </span>
    </div>
  )
}
