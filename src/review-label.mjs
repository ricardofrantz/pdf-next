/// Display numbers for reviews: `1.1`, `1.2`, `2.1`.
///
/// The first figure is the page (PDF) or the location rank (Markdown: the
/// first distinct start line in the file is 1, the next is 2). The second is
/// the review on that page or location, in id order, so a delete renumbers
/// the rest without rewriting the sidecar.

export function reviewIdNum(id) {
  const n = Number.parseInt(String(id || '').replace(/^r/i, ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : 0;
}

export function reviewPlace(review) {
  const page = Number(review?.at?.page);
  if (Number.isFinite(page) && page >= 1) {
    return { kind: 'page', n: page };
  }
  const line = Number(review?.at?.line);
  if (Number.isFinite(line) && line >= 1) {
    return { kind: 'line', n: line };
  }
  return { kind: 'page', n: 1 };
}

function minorIndex(peers, review) {
  const ordered = [...peers].sort((a, b) => reviewIdNum(a.id) - reviewIdNum(b.id));
  const found = ordered.findIndex((item) => item.id === review.id);
  return (found < 0 ? ordered.length : found) + 1;
}

/// Index of `needle` in a whitespace-normalised haystack. A short prefix is
/// enough when the full quote is longer than the joined layer we painted.
export function findNormalizedSpan(joined, needle) {
  const want = String(needle || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const hay = String(joined || '');
  if (want.length < 2 || !hay) {
    return null;
  }
  let start = hay.indexOf(want);
  let span = want.length;
  if (start < 0) {
    const short = want.slice(0, Math.min(24, want.length));
    start = hay.indexOf(short);
    span = short.length;
  }
  if (start < 0) {
    return null;
  }
  return { start, end: start + span };
}

export function reviewLabel(review, reviews) {
  const list = Array.isArray(reviews) ? reviews : [];
  const place = reviewPlace(review);
  if (place.kind === 'page') {
    const peers = list.filter((item) => {
      const other = reviewPlace(item);
      return other.kind === 'page' && other.n === place.n;
    });
    return `${place.n}.${minorIndex(peers, review)}`;
  }
  const lineReviews = list.filter((item) => reviewPlace(item).kind === 'line');
  const majors = [...new Set(lineReviews.map((item) => reviewPlace(item).n))].sort(
    (a, b) => a - b,
  );
  const major = majors.indexOf(place.n) + 1 || 1;
  const peers = lineReviews.filter((item) => reviewPlace(item).n === place.n);
  return `${major}.${minorIndex(peers, review)}`;
}
