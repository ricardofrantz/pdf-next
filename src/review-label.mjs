/// Stable review badges and conservative text matching helpers.

export function reviewIdNum(id) {
  const n = Number.parseInt(String(id || '').replace(/^r/i, ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : 0;
}

export function normalizeReviewText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/// Return the full quote only when it has one exact occurrence.
export function findNormalizedSpan(joined, needle) {
  const want = normalizeReviewText(needle);
  const hay = normalizeReviewText(joined);
  if (want.length < 2 || !hay) {
    return null;
  }
  const start = hay.indexOf(want);
  if (start < 0 || hay.indexOf(want, start + 1) >= 0) {
    return null;
  }
  return { start, end: start + want.length };
}

export function reviewLabel(review, reviews) {
  return String(review?.id || 'review');
}

export function reviewAction(review) {
  return review?.action === 'delete' ? 'delete' : 'improve';
}

export function reviewStatus(review) {
  return ['open', 'applied', 'resolved'].includes(review?.status) ? review.status : 'open';
}

export function reviewColor(review, count = 16) {
  const color = Number(review?.color);
  if (Number.isInteger(color) && color >= 1 && color <= count) return color;
  const n = reviewIdNum(review?.id);
  return n > 0 ? ((n - 1) % count) + 1 : 1;
}

export function sameReviewQuote(review, selectedQuote) {
  const quote = normalizeReviewText(review?.quote);
  return quote.length >= 2 && quote === normalizeReviewText(selectedQuote);
}

export function reattachedReviewAnchor(previous, next, at, quote) {
  const original = previous?.original ?? {
    anchor: previous ? { ...previous } : null,
    at: at ? { ...at } : {},
    quote: String(quote || ''),
  };
  return { ...next, original };
}

function matchesContext(text, start, end, anchor, loose = false) {
  const squeeze = (value) => (loose ? value.replace(/ /g, '') : value);
  const prefix = squeeze(normalizeReviewText(anchor?.prefix).slice(-48));
  const suffix = squeeze(normalizeReviewText(anchor?.suffix).slice(0, 48));
  return (!prefix || squeeze(text.slice(0, start).trimEnd()).endsWith(prefix)) &&
    (!suffix || squeeze(text.slice(end).trimStart()).startsWith(suffix));
}

/// Yield each occurrence of `want` in `text`. The loose form ignores spaces,
/// because PDF.js splits a word at a font change or inline math, and the
/// page text then has a space that the selected text does not have.
function* occurrences(text, want, loose) {
  if (!loose) {
    let from = 0;
    while ((from = text.indexOf(want, from)) >= 0) {
      yield { start: from, end: from + want.length };
      from += 1;
    }
    return;
  }
  const map = [];
  let compact = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ' ') {
      compact += text[index];
      map.push(index);
    }
  }
  const needle = want.replace(/ /g, '');
  // Without spaces, "in the wake" is also inside "within the wake". A loose
  // match must therefore start and end at a word boundary.
  const wordCharacter = (character) => /[\p{L}\p{N}]/u.test(character || '');
  let from = 0;
  while (needle && (from = compact.indexOf(needle, from)) >= 0) {
    const start = map[from];
    const end = map[from + needle.length - 1] + 1;
    if (!wordCharacter(text[start - 1]) && !wordCharacter(text[end])) yield { start, end };
    from += 1;
  }
}

/// Locate a quote by exact text and captured context. Repeated matches stay
/// unresolved unless context selects one candidate. A match that ignores
/// spaces is used only when the quote has no exact occurrence.
export function resolveReviewAnchor(pages, quote, anchor = {}) {
  const want = normalizeReviewText(quote);
  const list = (Array.isArray(pages) ? pages : []).map((item) => ({
    page: Number(item?.page), text: normalizeReviewText(item?.text),
  })).filter((item) => Number.isInteger(item.page) && item.page > 0);
  if (want.length < 2) return { status: 'unlocated' };
  const count = (loose) => list.reduce((total, item) => total + [...occurrences(item.text, want, loose)].length, 0);
  const exactCount = count(false);
  const loose = exactCount === 0;
  const found = [];
  for (const item of list) {
    for (const { start, end } of occurrences(item.text, want, loose)) {
      if (matchesContext(item.text, start, end, anchor, loose)) found.push({ page: item.page, start, end });
    }
  }
  if (found.length === 1) return { status: 'located', ...found[0] };
  if (found.length > 1) return { status: 'ambiguous' };
  return { status: (loose ? count(true) : exactCount) > 1 ? 'ambiguous' : 'unlocated' };
}
