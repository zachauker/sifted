CREATE VIRTUAL TABLE recipes_fts USING fts5(
  recipe_id UNINDEXED,
  title,
  ingredients,
  steps,
  notes,
  narrative,
  tokenize = 'porter unicode61'
);
