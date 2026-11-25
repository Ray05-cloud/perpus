/*
  One place for the saved-stories record.
  Both book pages write here, bookmarks.html reads here, so the count never
  drifts between tabs. Stored as a small JSON array in localStorage.
*/
(function () {
  var KEY = 'perpup.saved.v1';
  var LEGACY = 'perpup.bookmarked.hp6';

  var HP6 = {
    slug: 'hp6',
    title: 'Harry Potter: Half-Blood Prince',
    author: 'J.K. Rowling',
    cat: 'Fantasy and lore',
    cover: 'c-hp',
    series: 'Book six of seven'
  };

  function available() {
    try {
      localStorage.setItem('perpup.probe', '1');
      localStorage.removeItem('perpup.probe');
      return true;
    } catch (e) {
      return false;
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  function read() {
    var list = [];
    try {
      var raw = localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) list = parsed;
    } catch (e) {
      list = [];
    }

    list = list.filter(function (item) {
      return item && item.slug && item.title;
    });

    // A bookmark made before this record existed still counts.
    if (!list.length && localStorage.getItem(LEGACY) === '1') {
      var seed = Object.assign({}, HP6);
      seed.savedAt = new Date().toISOString();
      list = [seed];
      write(list);
    }

    return list;
  }

  function has(slug) {
    return read().some(function (item) { return item.slug === slug; });
  }

  function toggle(book) {
    var list = read();
    var at = -1;
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].slug === book.slug) { at = i; break; }
    }

    var added;
    if (at === -1) {
      var entry = Object.assign({}, book);
      entry.savedAt = new Date().toISOString();
      list.unshift(entry);
      added = true;
    } else {
      list.splice(at, 1);
      added = false;
    }

    write(list);
    if (book.slug === HP6.slug) {
      try { localStorage.setItem(LEGACY, added ? '1' : '0'); } catch (e) {}
    }
    return added;
  }

  function remove(slug) {
    var list = read().filter(function (item) { return item.slug !== slug; });
    write(list);
    return list;
  }

  function clear() {
    write([]);
    try { localStorage.setItem(LEGACY, '0'); } catch (e) {}
  }

  window.PerpusSaved = {
    KEY: KEY,
    HP6: HP6,
    available: available,
    read: read,
    has: has,
    toggle: toggle,
    remove: remove,
    clear: clear
  };
})();
