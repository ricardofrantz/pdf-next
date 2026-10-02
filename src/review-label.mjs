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

function matchesContext(text, start, end, anchor) {
  const prefix = normalizeReviewText(anchor?.prefix).slice(-48);
  const suffix = normalizeReviewText(anchor?.suffix).slice(0, 48);
  return (!prefix || text.slice(0, start).trimEnd().endsWith(prefix)) &&
    (!suffix || text.slice(end).trimStart().startsWith(suffix));
}

/// Locate a quote by exact text and captured context. Repeated matches stay
/// unresolved unless context selects one candidate.
export function resolveReviewAnchor(pages, quote, anchor = {}) {
  const want = normalizeReviewText(quote);
  const list = (Array.isArray(pages) ? pages : []).map((item) => ({
    page: Number(item?.page), text: normalizeReviewText(item?.text),
  })).filter((item) => Number.isInteger(item.page) && item.page > 0);
  if (want.length < 2) return { status: 'unlocated' };
  const scan = (items) => {
    const found = [];
    for (const item of items) {
      let from = 0;
      while ((from = item.text.indexOf(want, from)) >= 0) {
        const end = from + want.length;
        if (matchesContext(item.text, from, end, anchor)) {
          found.push({ page: item.page, start: from, end });
        }
        from = end;
      }
    }
    return found;
  };
  const all = scan(list);
  if (all.length === 1) return { status: 'located', ...all[0] };
  if (all.length > 1) return { status: 'ambiguous' };
  const rawCount = list.reduce((count, item) => {
    let from = 0;
    while ((from = item.text.indexOf(want, from)) >= 0) {
      count += 1;
      from += want.length;
    }
    return count;
  }, 0);
  return { status: rawCount > 1 ? 'ambiguous' : 'unlocated' };
}
