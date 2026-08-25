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
})
