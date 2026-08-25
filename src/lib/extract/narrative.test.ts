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
