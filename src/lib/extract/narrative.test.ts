import { describe, it, expect } from 'vitest'
import { extractNarrative } from './narrative'

const article = `
  <html><head><title>Flatbread</title></head><body>
    <nav>Home About Contact</nav>
    <article>
      <h1>Homemade Flatbread</h1>
      <p>Flatbread is some serious comfort food for this Macedonian girl. Carbs, carbs, carbs!
         They make everything better, right? Your go-to carb might be a big crusty loaf of French
         bread, but for me, flatbread is where it is at, every single time I get the chance.</p>
      <p>I love to make my own flatbread because it is quick and easy, and it is easier than most
         breads because you do not need to let it rise for very long at all before cooking.</p>
      <div class="wprm-recipe-container">
        <h2>Easy Homemade Flatbread Recipe</h2>
        <ul><li>1 cup water</li><li>3 cups flour</li></ul>
      </div>
    </article>
    <footer>Copyright 2022</footer>
  </body></html>
`

describe('extractNarrative', () => {
  it('returns the article prose', () => {
    const html = extractNarrative(article)
    expect(html).toContain('Macedonian girl')
  })

  it('removes the recipe card so the story is not duplicated', () => {
    const html = extractNarrative(article)
    expect(html).not.toContain('3 cups flour')
  })

  it('drops navigation and footer chrome', () => {
    const html = extractNarrative(article)
    expect(html).not.toContain('Home About Contact')
    expect(html).not.toContain('Copyright 2022')
  })

  it('returns null when there is no meaningful prose', () => {
    expect(extractNarrative('<html><body><div>Hi</div></body></html>')).toBeNull()
  })

  it('keeps the story when a legacy theme puts itemscope Recipe on the whole article wrapper', () => {
    const legacyThemeArticle = `
      <html><head><title>Flatbread</title></head><body>
        <nav>Home About Contact</nav>
        <article itemscope itemtype="https://schema.org/Recipe">
          <h1>Homemade Flatbread</h1>
          <p>Flatbread is some serious comfort food for this Macedonian girl. Carbs, carbs, carbs!
             They make everything better, right? Your go-to carb might be a big crusty loaf of French
             bread, but for me, flatbread is where it is at, every single time I get the chance.</p>
          <p>I love to make my own flatbread because it is quick and easy, and it is easier than most
             breads because you do not need to let it rise for very long at all before cooking. It is
             a tradition passed down from my grandmother, who taught me everything I know about bread
             and about patience in the kitchen, long before I ever thought to write it down.</p>
          <ul><li itemprop="recipeIngredient">1 cup water</li><li itemprop="recipeIngredient">3 cups flour</li></ul>
        </article>
        <footer>Copyright 2022</footer>
      </body></html>
    `
    const html = extractNarrative(legacyThemeArticle)
    expect(html).toContain('Macedonian girl')
  })

  it('still removes a small itemtype recipe card nested in a long article', () => {
    const smallItemtypeCard = `
      <html><head><title>Flatbread</title></head><body>
        <nav>Home About Contact</nav>
        <article>
          <h1>Homemade Flatbread</h1>
          <p>Flatbread is some serious comfort food for this Macedonian girl. Carbs, carbs, carbs!
             They make everything better, right? Your go-to carb might be a big crusty loaf of French
             bread, but for me, flatbread is where it is at, every single time I get the chance.</p>
          <p>I love to make my own flatbread because it is quick and easy, and it is easier than most
             breads because you do not need to let it rise for very long at all before cooking. It is
             a tradition passed down from my grandmother, who taught me everything I know about bread
             and about patience in the kitchen, long before I ever thought to write it down.</p>
          <p>Every family in the region seems to have their own version, and mine leans heavily on
             good olive oil and a very hot pan, rather than anything fancy or hard to find.</p>
          <div itemscope itemtype="https://schema.org/Recipe">
            <h2>Easy Homemade Flatbread Recipe</h2>
            <ul><li itemprop="recipeIngredient">1 cup water</li><li itemprop="recipeIngredient">3 cups flour</li></ul>
          </div>
        </article>
        <footer>Copyright 2022</footer>
      </body></html>
    `
    const html = extractNarrative(smallItemtypeCard)
    expect(html).toContain('Macedonian girl')
    expect(html).not.toContain('3 cups flour')
  })

  it('returns null for a card-only page with no story', () => {
    const cardOnly = `
      <html><head><title>Flatbread</title></head><body>
        <nav>Home About Contact</nav>
        <article>
          <div class="wprm-recipe-container">
            <h2>Easy Homemade Flatbread Recipe</h2>
            <ul><li>1 cup water</li><li>3 cups flour</li></ul>
          </div>
        </article>
        <footer>Copyright 2022</footer>
      </body></html>
    `
    expect(extractNarrative(cardOnly)).toBeNull()
  })
})

/**
 * Condé Nast (Bon Appétit, Epicurious) ships a custom React recipe layout that
 * matches none of the recipe-plugin class selectors, so before this the whole
 * recipe -- ingredients, numbered steps, "Do Ahead" -- came back as "narrative".
 */
describe('extractNarrative: Condé Nast markup', () => {
  const conde = `
    <html><head><title>Cheesy Cabbage Gratin</title></head><body>
      <nav>Home Recipes Subscribe</nav>
      <article>
        <h1>Cheesy Cabbage Gratin</h1>
        <div data-testid="recipe__main-content">
          <p>Every editor who claimed this cheesy gratin would be too much ended up going back for
             seconds and thirds, which tells you most of what you need to know about cabbage, cream,
             and a very hot broiler on a cold evening in the middle of November.</p>
        </div>
        <div data-testid="InfoSliceList"><h2>Recipe information</h2><p>Yield</p><p>8 servings</p></div>
        <div data-testid="IngredientList">
          <h2>Ingredients</h2>
          <p>1</p><p>medium head of green or savoy cabbage, cut through core into 8 wedges</p>
          <p>2</p><p>cups heavy cream</p>
        </div>
        <div data-testid="InstructionsWrapper">
          <h2>Preparation</h2>
          <ol><li>
            <h4>Step 1</h4>
            <p>Place oven racks in upper third and middle of oven; preheat to 350 degrees.</p>
          </li></ol>
        </div>
      </article>
      <footer>Condé Nast Store. All rights reserved. Ad Choices.</footer>
    </body></html>
  `

  it('keeps the editorial headnote', () => {
    expect(extractNarrative(conde)).toContain('going back for')
  })

  it('drops the ingredient list, the steps, and the yield slice', () => {
    const html = extractNarrative(conde)
    expect(html).not.toContain('Step 1')
    expect(html).not.toContain('cups heavy cream')
    expect(html).not.toContain('preheat to 350 degrees')
    expect(html).not.toContain('Recipe information')
  })

  /**
   * Removing the recipe leaves this page with one sentence of editorial copy,
   * which the site footer's legalese would outscore if it were still in the
   * document when Readability picked its candidate.
   */
  it('does not fall back to footer boilerplate once the recipe is removed', () => {
    expect(extractNarrative(conde)).not.toContain('Ad Choices')
  })
})

/**
 * The selector list only covers publishers someone has already looked at. The
 * recipe body is parsed before the narrative, though, so the exact step and
 * ingredient text is known for every page -- which generalizes to publisher
 * number 61.
 */
describe('extractNarrative: de-duplication against the extracted recipe', () => {
  const STEPS = [
    'Toast the peanuts in a dry skillet over medium heat until they smell nutty and are just beginning to brown at the edges.',
    'Blend the toasted peanuts with the garlic, lime juice, and fish sauce until the mixture is completely smooth and glossy.',
  ]
  const INGREDIENTS = ['1 cup roasted peanuts', '3 cloves garlic, finely minced']

  const story = `<p>My grandmother made this dip every single summer for as long as I can remember, and the
    smell of peanuts hitting a hot pan still puts me straight back in her kitchen with the screen door
    banging and the radio on far too loud for the size of the room.</p>`

  function page(body: string): string {
    return `<html><head><title>Peanut Dip</title></head><body><article>
      <h1>Peanut Dip</h1>${story}${body}</article></body></html>`
  }

  it('removes an unrecognized recipe card that duplicates the steps', () => {
    const html = extractNarrative(
      page(`<section class="some-unknown-plugin"><h2>Directions</h2>
        <ol><li>${STEPS[0]}</li><li>${STEPS[1]}</li></ol></section>`),
      { steps: STEPS, ingredients: INGREDIENTS },
    )

    expect(html).toContain('banging and the radio on')
    expect(html).not.toContain('Toast the peanuts')
    expect(html).not.toContain('until the mixture is completely smooth')
  })

  it('removes ingredient lines split across quantity and description cells', () => {
    const html = extractNarrative(
      page(`<div class="odd-card"><p>3</p><p>cloves garlic, finely minced</p></div>`),
      { steps: STEPS, ingredients: INGREDIENTS },
    )

    expect(html).not.toContain('cloves garlic, finely minced')
  })

  it('keeps prose that merely mentions an ingredient', () => {
    const html = extractNarrative(
      page(`<p>I love garlic. I have never once measured it, and I would sooner leave out the
        peanuts than be stingy with it, whatever the recipe below happens to claim.</p>`),
      { steps: STEPS, ingredients: INGREDIENTS },
    )

    expect(html).toContain('I love garlic')
  })

  /**
   * A headnote that quotes a step and then talks about it is the author's
   * writing, not the recipe card. Only a block that is essentially nothing but
   * the step goes.
   */
  it('keeps a paragraph that quotes a step inside real commentary', () => {
    const html = extractNarrative(
      page(`<p>The instruction below says to ${STEPS[0]} That is the step everyone rushes, and
        rushing it is exactly why most versions of this dip taste of raw nuts and disappointment
        rather than of anything you would want to eat twice in one week.</p>`),
      { steps: STEPS, ingredients: INGREDIENTS },
    )

    expect(html).toContain('raw nuts and disappointment')
  })

  it('returns null rather than a stub when only the recipe was there', () => {
    const cardOnly = `<html><head><title>Peanut Dip</title></head><body><article>
      <h1>Peanut Dip</h1><ol><li>${STEPS[0]}</li><li>${STEPS[1]}</li></ol></article></body></html>`

    // Without the recipe body there is enough text to clear MIN_NARRATIVE_LENGTH,
    // so this pins that the null below comes from de-duplication and not from the
    // page being too short to begin with.
    expect(extractNarrative(cardOnly)).toContain('Toast the peanuts')
    expect(extractNarrative(cardOnly, { steps: STEPS, ingredients: INGREDIENTS })).toBeNull()
  })

  it('ignores recipe lines too short to be distinctive', () => {
    const html = extractNarrative(
      page(`<p>Salt is the whole trick here, and I mean rather more of it than feels decent at the
        time you are adding it to the pan.</p>`),
      { steps: [], ingredients: ['Salt'] },
    )

    expect(html).toContain('Salt is the whole trick here')
  })
})
