/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../scripts/repair-images'

describe('repair-images argument parsing', () => {
  it('refuses a run that would do nothing', () => {
    expect(() => parseArgs([])).toThrow(/nothing to do/)
  })

  it('refuses --recipe without --from, and vice versa', () => {
    expect(() => parseArgs(['--recipe=abc'])).toThrow(/go together/)
    expect(() => parseArgs(['--from=https://x/y.jpg'])).toThrow(/go together/)
  })

  it('rejects an unknown argument rather than silently ignoring it', () => {
    // A typo'd flag that parsed as "do nothing" would look like a successful
    // no-op run, which is the worst possible outcome for a repair command.
    expect(() => parseArgs(['--repair-url'])).toThrow(/unknown argument/)
  })

  it('rejects a nonsense --limit', () => {
    expect(() => parseArgs(['--missing', '--limit=0'])).toThrow(/bad --limit/)
    expect(() => parseArgs(['--missing', '--limit=abc'])).toThrow(/bad --limit/)
  })

  it('reads the modes it is given', () => {
    const o = parseArgs(['--repair-urls', '--missing', '--dry-run', '--limit=5'])
    expect(o).toMatchObject({ repairUrls: true, missing: true, dryRun: true, limit: 5 })
  })

  it('takes a recipe and an image together', () => {
    expect(parseArgs(['--recipe=ham-pot-pie-xgl3ncf6', '--from=https://cdn/x.jpg']))
      .toMatchObject({ recipeId: 'ham-pot-pie-xgl3ncf6', from: 'https://cdn/x.jpg' })
  })
})
