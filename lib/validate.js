/*
  Validation for a bookmark payload (POST /api/saved).

  A bookmark row keeps its own copy of the title, author and cover, so a saved
  book still reads correctly after the shelf row is edited or removed. That is
  why the payload carries all of those fields instead of just a slug.

  Scope, deliberately narrow: this only guards the bookmark shape. Creating a
  book goes through createBook in server.js, which has its own rules. The two
  are not the same contract and should not be merged.

  Known gaps, kept as-is until the validation pass so the behaviour does not
  change under a running site:
  - optional text fields are truncated to their limit rather than rejected, so
    an over-long author silently loses characters instead of returning 400;
  - a non-string optional field becomes null instead of an error;
  - the slug pattern is case-insensitive, so "Beauty" passes here but would not
    match the lower-case slug stored in books.
*/

const SLUG = /^[a-z0-9-]{1,64}$/i;

export function validateBook(body) {
  const source = body && typeof body === 'object' ? body : {};

  const slug = typeof source.slug === 'string' ? source.slug.trim() : '';
  const title = typeof source.title === 'string' ? source.title.trim() : '';

  if (!slug || !SLUG.test(slug)) {
    return { error: 'slug must be 1-64 letters, digits or dashes' };
  }
  if (!title || title.length > 300) {
    return { error: 'title is required and must be under 300 characters' };
  }

  const field = (value, max) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

  return {
    book: {
      slug,
      title,
      author: field(source.author, 200),
      cat: field(source.cat, 80),
      cover: field(source.cover, 40),
      series: field(source.series, 200)
    }
  };
}
