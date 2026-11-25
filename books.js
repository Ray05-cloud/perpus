/*
  The shelf, read from the database instead of being hardcoded here.

  This file used to hold all eight books inline. They now live in the `books`
  table and are served at GET /api/books, so a book added to the database opens
  at book.html?slug=<slug> without editing any file. db/books.seed.json keeps
  the original eight records, which is what scripts/seed-books.js loads.

  Loading is asynchronous, which means pages must wait on PerpusBooks.ready
  before reading book data. The record shape is unchanged, so the rendering
  code did not need to be rewritten.
*/
(function () {
  var books = {};      // slug -> record
  var order = [];      // display order
  var failure = null;  // message when the shelf could not be loaded

  function index(payload) {
    books = {};
    order = [];

    (payload.books || []).forEach(function (book) {
      if (!book || !book.slug) return;
      books[book.slug] = book;
      order.push(book.slug);
    });
  }

  var ready = fetch('/api/books', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('Shelf request failed (' + res.status + ')');
      return res.json();
    })
    .then(function (payload) {
      index(payload);
      return true;
    })
    .catch(function (err) {
      failure = err.message;
      if (window.console) console.error('Shelf unavailable:', err.message);
      return false;
    });

  function get(slug) {
    return books[slug] || null;
  }

  function requestedSlug() {
    try {
      return new URLSearchParams(window.location.search).get('slug');
    } catch (e) {
      return null;
    }
  }

  // A missing or unknown slug still has to render a page, so it falls back to
  // the first book on the shelf. The old fallback was a hardcoded hp6, which
  // only made sense while the books lived in this file.
  function current() {
    return get(requestedSlug()) || (order.length ? books[order[0]] : null);
  }

  function url(slug) {
    return 'book.html?slug=' + encodeURIComponent(slug);
  }

  window.PerpusBooks = {
    ready: ready,
    get: get,
    current: current,
    url: url,
    all: function () {
      return order.map(get);
    },
    order: function () {
      return order.slice();
    },
    count: function () {
      return order.length;
    },
    failure: function () {
      return failure;
    }
  };
})();
