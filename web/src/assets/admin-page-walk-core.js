// Pure, DOM-free page-walk for the admin inventory consoles (admin-events.js / admin-venues.js,
// TM-392 / TM-519) — extracted so its contract is unit-testable (admin-page-walk-core.test.mjs)
// without a browser. Both consoles load their WHOLE (small) inventory up front by walking the paged
// admin endpoint, then search/filter/sort/paginate in memory.
//
// The contract this enforces (TM-727 — the previous inline loops silently broke both halves):
//
//   * A page failing MID-WALK keeps everything loaded so far and reports `partial: true` — it never
//     throws away the pages that DID load. Only a failure on the FIRST page (nothing loaded) surfaces
//     as `error` with an empty result, so the table can show the error + Retry.
//   * Hitting the runaway page guard without the server signalling "last page" reports
//     `truncated: true` — the inventory is larger than the guard allows and what we hold is a prefix,
//     not the whole set. The caller MUST surface this rather than pretend the load was complete.
//
// `complete` is true only when the server signalled the last page (a short page, or page+1 >=
// totalPages) — i.e. neither truncated nor cut short by an error.

/**
 * Walk `fetchPage(page)` from page 0 upward, accumulating each page's items, until the server signals
 * the last page, an error is thrown, or `maxPages` is reached.
 *
 * @param {(page: number) => Promise<any>} fetchPage resolves to a page envelope
 *        (`{ items, totalElements, totalPages }`); may reject to signal a failed page.
 * @param {object} opts
 * @param {number} opts.pageSize   the size requested per page (a short page ends the walk)
 * @param {number} opts.maxPages   the runaway guard — stop after this many pages
 * @returns {Promise<{
 *   items: any[],        // everything that loaded, in server order
 *   total: number,       // best totalElements seen, floored at items.length
 *   complete: boolean,   // the server signalled the last page (full, untruncated load)
 *   partial: boolean,    // a page failed mid-walk; `items` is a prefix of the true set
 *   truncated: boolean,  // the runaway guard tripped before the last page; `items` is a prefix
 *   error: Error|null,   // the failure — only surfaced (as a load error) when nothing loaded
 * }>}
 */
export async function walkPages(fetchPage, { pageSize, maxPages }) {
  const items = [];
  let total = 0;
  let complete = false;
  let partial = false;
  let error = null;

  for (let page = 0; page < maxPages; page += 1) {
    let envelope;
    try {
      envelope = await fetchPage(page);
    } catch (err) {
      // A page failed mid-walk. Keep every page that loaded before it (partial), and only bubble the
      // error to the caller when NOTHING loaded so an empty table can show it. Stop walking either way.
      error = err instanceof Error ? err : new Error(String(err));
      partial = items.length > 0;
      break;
    }
    const pageItems = Array.isArray(envelope?.items) ? envelope.items : [];
    items.push(...pageItems);
    const reported = Number(envelope?.totalElements);
    if (Number.isFinite(reported)) total = Math.max(total, reported);
    const totalPages = Number(envelope?.totalPages);
    const lastByServer = Number.isFinite(totalPages) && page + 1 >= totalPages;
    if (lastByServer || pageItems.length < pageSize) {
      complete = true;
      break;
    }
  }

  // Ran the whole guard without the server ever signalling the last page (and without an error): the
  // real inventory is bigger than the guard allows, so what we hold is a truncated prefix.
  const truncated = !complete && error === null;

  return {
    items,
    total: Math.max(total, items.length),
    complete,
    partial,
    truncated,
    // Only a first-page failure (nothing loaded) is a load error the table must render; a mid-walk
    // failure is reported via `partial` with the pages that survived.
    error: items.length === 0 ? error : null,
  };
}
