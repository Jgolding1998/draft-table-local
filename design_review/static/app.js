/* Draft Table — local design feedback.
   No external requests. All user data is rendered with textContent / attributes only. */
(() => {
  'use strict';

  // ---------- State ----------

  const STATUSES = [
    { id: 'exploring', label: 'Exploring' },
    { id: 'shortlisted', label: 'Shortlisted' },
    { id: 'approved', label: 'Approved' },
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));
  const ACCEPT_TYPES = ['image/png', 'image/jpeg'];
  const TITLE_MAX = 100; // server: boards and designs, 1-100 characters
  const COMMENT_MAX = 2000; // server: comments and replies, 1-2000 characters
  // Count code points like the server does, and never split a surrogate pair.
  const charLen = (v) => Array.from(String(v)).length;
  const clip = (v, max) => Array.from(String(v)).slice(0, max).join('');
  // The server rejects control characters other than tab, CR and LF.
  const stripControl = (v) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const DEFAULT_LIMITS = { upload_bytes: 8388608, max_designs: 100, max_boards: 20 };

  const S = { csrf: '', boards: [], designs: [], limits: { ...DEFAULT_LIMITS }, loaded: false };
  const ui = {
    boardId: null,
    view: 'gallery',
    filter: 'all',
    detailId: null,
    detailList: [],
    replyTo: null,
    zoom: false,
    pending: 0,
    failed: false,
    uploading: null,
    bootstrapTried: false,
  };

  // ---------- DOM helpers ----------

  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    appendKids(el, kids);
    return el;
  }

  function appendKids(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }

  const ICONS = {
    plus: ['M12 5v14', 'M5 12h14'],
    upload: ['M12 15V4', 'M7.5 8.5 12 4l4.5 4.5', 'M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14'],
    download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14'],
    pencil: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z', 'M13.5 8.5l2 2'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 19l1-12', 'M9 7V4.5h6V7'],
    x: ['M6 6l12 12', 'M18 6 6 18'],
    chevronLeft: ['M14.5 6 8.5 12l6 6'],
    chevronRight: ['M9.5 6l6 6-6 6'],
    chevronDown: ['M7 10l5 5 5-5'],
    grid: ['M4.5 4.5h6v6h-6z', 'M13.5 4.5h6v6h-6z', 'M4.5 13.5h6v6h-6z', 'M13.5 13.5h6v6h-6z'],
    columns: ['M4.5 5h6v14h-6z', 'M13.5 5h6v14h-6z'],
    message: ['M5 5.5h14a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H10l-4.5 3.5V16H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z'],
    reply: ['M9.5 7 5 11.5 9.5 16', 'M5 11.5h9a5 5 0 0 1 5 5V18'],
    layers: ['M12 4.5 20 8.5l-8 4-8-4z', 'M4 12.5l8 4 8-4', 'M4 16.5l8 4 8-4'],
    maximize: ['M4.5 9V4.5H9', 'M15 4.5h4.5V9', 'M19.5 15v4.5H15', 'M9 19.5H4.5V15'],
    minimize: ['M9 4.5V9H4.5', 'M15 4.5V9h4.5', 'M15 19.5V15h4.5', 'M9 19.5V15H4.5'],
    refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
    alert: ['M12 4.5 20.5 19h-17z', 'M12 10v4', 'M12 16.75v.01'],
    drive: ['M4 13.5h16v5H4z', 'M4 13.5 6.5 6h11l2.5 7.5', 'M7.5 16h.01', 'M10.5 16h.01'],
    image: ['M4.5 5h15v14h-15z', 'M4.5 16l4.5-4.5 4 4 2.5-2.5 4 4', 'M15 9.25h.01'],
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((slot) => {
      if (slot.firstChild) return;
      slot.append(icon(slot.dataset.icon));
      slot.setAttribute('aria-hidden', 'true');
    });
  }

  // ---------- Formatting ----------

  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const n = Number(v);
    if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(String(v))) return new Date(n < 1e12 ? n * 1000 : n);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const relFmt = typeof Intl.RelativeTimeFormat === 'function' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
  const numFmt = new Intl.NumberFormat();

  function relTime(v) {
    const d = toDate(v);
    if (!d) return '';
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(sec);
    if (abs < 45) return 'just now';
    if (!relFmt) return dateFmt.format(d);
    if (abs < 3600) return relFmt.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return relFmt.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 7) return relFmt.format(Math.round(sec / 86400), 'day');
    return dateFmt.format(d);
  }

  function timeEl(v) {
    const d = toDate(v);
    if (!d) return h('span', { text: '' });
    return h('time', { datetime: d.toISOString(), title: fullFmt.format(d), text: relTime(v) });
  }

  function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  const plural = (n, one, many) => `${numFmt.format(n)} ${n === 1 ? one : many}`;
  const titleOf = (x, fallback) => (x && typeof x.title === 'string' && x.title.trim()) || fallback;

  // ---------- API ----------

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  const STATUS_MESSAGES = {
    400: 'That request didn’t look right. Check the input and try again.',
    403: 'This page’s session expired. Reload the page and try again.',
    404: 'That item no longer exists. It may have been deleted.',
    409: 'That change conflicts with the current data. Refresh and try again.',
    413: 'That file is too large.',
    415: 'Only PNG and JPEG images can be added.',
    429: 'Too many changes at once. Wait a moment and try again.',
    503: 'Draft Table is busy. Wait a moment and try again.',
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(method, path, opts = {}, retried = false, attempt = 0) {
    const init = { method, headers: {}, credentials: 'same-origin', cache: 'no-store' };
    if (method !== 'GET') init.headers['X-CSRF-Token'] = S.csrf;
    if (opts.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      init.headers['Content-Type'] = opts.type;
      init.body = opts.body;
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (_) {
      throw new ApiError(0, 'Can’t reach Draft Table. Make sure it’s still running on this computer.');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      // The local server answers 503 before processing when its few request slots are full.
      if (res.status === 503 && attempt < 3) {
        await wait(250 * (attempt + 1) + Math.floor(Math.random() * 150));
        return api(method, path, opts, retried, attempt + 1);
      }
      if (res.status === 403 && method !== 'GET' && !retried) {
        // Token may be stale after a restart; refresh it once and retry.
        try {
          const fresh = await api('GET', '/api/state');
          if (fresh && typeof fresh.csrf === 'string') S.csrf = fresh.csrf;
          return api(method, path, opts, true);
        } catch (_) { /* fall through */ }
      }
      const msg = data && typeof data.error === 'string' && data.error.trim()
        ? data.error.trim()
        : (STATUS_MESSAGES[res.status] || `Something went wrong (${res.status}).`);
      throw new ApiError(res.status, msg);
    }
    return data || {};
  }

  // ---------- Save status ----------

  function setSaveState() {
    const el = $('save-status');
    const text = $('save-text');
    const short = $('save-short');
    let state;
    let label;
    let brief;
    if (ui.pending > 0) { state = 'saving'; label = 'Saving'; brief = 'Saving'; }
    else if (ui.failed) { state = 'error'; label = 'Last change not saved'; brief = 'Not saved'; }
    else if (S.loaded) { state = 'saved'; label = 'Saved on this computer'; brief = 'Saved'; }
    else { state = 'idle'; label = 'Stored on this computer'; brief = 'Local'; }
    if (el.dataset.state !== state) el.dataset.state = state;
    if (text.textContent !== label) text.textContent = label;
    // Short visual label for small screens; the full label stays available to assistive tech.
    if (short.textContent !== brief) short.textContent = brief;
    el.title = label;
  }

  /** Run a mutation, refresh state, report the outcome. Returns the result or undefined on failure. */
  async function mutate(fn, { success, refresh = true } = {}) {
    ui.pending += 1;
    setSaveState();
    try {
      const result = await fn();
      ui.failed = false;
      if (refresh) await loadState({ quiet: true });
      if (success) toast(success);
      return result === undefined ? true : result;
    } catch (err) {
      ui.failed = true;
      toast(err.message || 'Something went wrong.', { error: true });
      if (err.status === 404) await loadState({ quiet: true });
      return undefined;
    } finally {
      ui.pending -= 1;
      setSaveState();
    }
  }

  // ---------- Toasts ----------

  function toast(message, { error = false } = {}) {
    const wrap = $('toasts');
    const close = h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss' }, icon('x'));
    const node = h('div', { class: `toast${error ? ' is-error' : ''}`, role: error ? 'alert' : null },
      h('span', { class: 'toast-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'toast-text', text: message }),
      close);
    const remove = () => node.remove();
    close.addEventListener('click', remove);
    // A new success replaces older successes; errors stay until they time out or are dismissed.
    if (!error) wrap.querySelectorAll('.toast:not(.is-error)').forEach((old) => old.remove());
    wrap.append(node);
    while (wrap.children.length > 3) wrap.firstElementChild.remove();
    setTimeout(remove, error ? 9000 : 4500);
  }

  // ---------- Loading state ----------

  function normalize(data) {
    const boards = Array.isArray(data.boards) ? data.boards.filter((b) => b && typeof b.id === 'string') : [];
    const designs = Array.isArray(data.designs) ? data.designs.filter((d) => d && typeof d.id === 'string') : [];
    for (const d of designs) {
      if (!STATUS_LABEL[d.status]) d.status = 'exploring';
      d.comments = Array.isArray(d.comments) ? d.comments.filter((c) => c && typeof c.id === 'string') : [];
    }
    const t = (x) => (toDate(x.created_at) || new Date(0)).getTime();
    boards.sort((a, b) => t(a) - t(b));
    designs.sort((a, b) => t(b) - t(a));
    S.csrf = typeof data.csrf === 'string' ? data.csrf : S.csrf;
    S.boards = boards;
    S.designs = designs;
    S.limits = { ...DEFAULT_LIMITS, ...(data.limits || {}) };
    S.loaded = true;
  }

  async function loadState({ quiet = false } = {}) {
    if (!quiet && !S.loaded) showView('loading');
    let data;
    try {
      data = await api('GET', '/api/state');
    } catch (err) {
      if (!S.loaded) showError(err.message);
      else toast(err.message, { error: true });
      return false;
    }
    normalize(data);
    if (!S.boards.length && !ui.bootstrapTried) {
      ui.bootstrapTried = true;
      try {
        await api('POST', '/api/boards', { json: { title: 'First board' } });
        return loadState({ quiet: true });
      } catch (_) { /* render the no-board state below */ }
    }
    syncBoardFromHash();
    render();
    return true;
  }

  function showView(name) {
    $('app').dataset.view = name;
    $('view-loading').hidden = name !== 'loading';
    $('view-error').hidden = name !== 'error';
    $('view-board').hidden = name !== 'board';
  }

  function showError(message) {
    $('error-text').textContent = message;
    showView('error');
    setSaveState();
  }

  // ---------- Routing ----------

  function boardFromHash() {
    const m = /^#board\/([0-9a-f]{32})$/i.exec(location.hash);
    return m ? m[1].toLowerCase() : null;
  }

  function syncBoardFromHash() {
    const fromHash = boardFromHash();
    if (fromHash && S.boards.some((b) => b.id === fromHash)) ui.boardId = fromHash;
    if (!S.boards.some((b) => b.id === ui.boardId)) ui.boardId = S.boards.length ? S.boards[0].id : null;
  }

  function selectBoard(id) {
    if (id === ui.boardId) return;
    ui.boardId = id;
    ui.filter = 'all';
    const target = `#board/${id}`;
    if (location.hash !== target) history.pushState(null, '', target);
    render();
    const title = $('board-title');
    if (title) title.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  window.addEventListener('popstate', () => {
    const id = boardFromHash();
    if (id && S.boards.some((b) => b.id === id) && id !== ui.boardId) {
      ui.boardId = id;
      ui.filter = 'all';
      render();
    }
  });

  // ---------- Selectors ----------

  const currentBoard = () => S.boards.find((b) => b.id === ui.boardId) || null;
  const boardDesigns = (boardId = ui.boardId) => S.designs.filter((d) => d.board_id === boardId);
  const findDesign = (id) => S.designs.find((d) => d.id === id) || null;
  const commentCount = (d) => d.comments.length;

  function visibleDesigns() {
    const list = boardDesigns();
    if (ui.view === 'compare') return list.filter((d) => d.status !== 'exploring');
    return ui.filter === 'all' ? list : list.filter((d) => d.status === ui.filter);
  }

  // ---------- Render ----------

  function render() {
    const active = document.activeElement;
    const fk = active && active.closest ? (active.closest('[data-fk]') || {}).dataset : null;
    const focusKey = fk ? fk.fk : null;

    renderBoardLists();
    renderUsage();
    renderExport();

    const board = currentBoard();
    if (!board) {
      renderNoBoard();
    } else {
      showView('board');
      renderBoardHead(board);
      renderToolbar();
      renderUploadBar();
      renderBody();
    }

    if (ui.detailId) {
      if (findDesign(ui.detailId)) renderDetail();
      else closeDetail();
    }

    setSaveState();

    if (focusKey && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) {
      const el = document.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  function renderNoBoard() {
    showView('board');
    $('board-title').textContent = 'No boards yet';
    $('board-meta').textContent = 'Create a board to start collecting designs.';
    $('rename-board').hidden = true;
    $('delete-board').hidden = true;
    $('toolbar').hidden = true;
    $('upload-bar').hidden = true;
    const body = $('board-body');
    body.replaceChildren(
      h('div', { class: 'empty-small' },
        h('h2', { class: 'empty-title', text: 'Start with a board' }),
        h('p', { class: 'empty-text', text: 'Boards keep related designs together, like one screen or one round of ideas.' }),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: newBoard }, icon('plus'), h('span', { text: 'New board' }))));
  }

  function renderBoardLists() {
    const counts = new Map();
    for (const d of S.designs) counts.set(d.board_id, (counts.get(d.board_id) || 0) + 1);
    for (const [listId, prefix] of [['board-list', 'nav'], ['board-list-sheet', 'sheet']]) {
      const list = $(listId);
      list.replaceChildren(...S.boards.map((b) => {
        const n = counts.get(b.id) || 0;
        return h('li', null,
          h('button', {
            class: 'board-link',
            type: 'button',
            'aria-current': b.id === ui.boardId ? 'page' : null,
            dataset: { fk: `${prefix}-board-${b.id}` },
            onclick: () => {
              if (listId === 'board-list-sheet') $('dlg-boards').close();
              selectBoard(b.id);
            },
          },
          icon('layers'),
          h('span', { class: 'board-link-name', text: titleOf(b, 'Untitled board') }),
          h('span', { class: 'board-link-count', 'aria-hidden': 'true', text: numFmt.format(n) }),
          h('span', { class: 'visually-hidden', text: `, ${plural(n, 'design', 'designs')}` })));
      }));
    }
    const atMax = S.boards.length >= S.limits.max_boards;
    for (const id of ['new-board', 'new-board-sheet']) {
      const btn = $(id);
      btn.disabled = atMax;
      btn.title = atMax ? `Limit of ${S.limits.max_boards} boards reached` : 'New board';
    }
  }

  function renderUsage() {
    $('usage').textContent = `${numFmt.format(S.designs.length)} of ${numFmt.format(S.limits.max_designs)} designs`;
  }

  function renderExport() {
    $('export-board').href = ui.boardId ? `/api/export?board=${encodeURIComponent(ui.boardId)}` : '/api/export';
  }

  function renderBoardHead(board) {
    const list = boardDesigns();
    const title = titleOf(board, 'Untitled board');
    $('board-title').textContent = title;
    document.title = `${title} · Draft Table`;
    $('rename-board').hidden = false;
    $('delete-board').hidden = false;
    $('toolbar').hidden = false;

    const shortlisted = list.filter((d) => d.status === 'shortlisted').length;
    const approved = list.filter((d) => d.status === 'approved').length;
    const parts = [plural(list.length, 'design', 'designs')];
    if (shortlisted) parts.push(`${numFmt.format(shortlisted)} shortlisted`);
    if (approved) parts.push(`${numFmt.format(approved)} approved`);
    const created = toDate(board.created_at);
    if (created) parts.push(`started ${dateFmt.format(created)}`);
    $('board-meta').textContent = parts.join(' · ');
  }

  function renderToolbar() {
    const list = boardDesigns();
    $('view-gallery').setAttribute('aria-pressed', String(ui.view === 'gallery'));
    $('view-compare').setAttribute('aria-pressed', String(ui.view === 'compare'));

    const filters = $('filters');
    filters.hidden = ui.view !== 'gallery' || list.length === 0;
    const opts = [{ id: 'all', label: 'All' }, ...STATUSES];
    filters.replaceChildren(...opts.map((o) => {
      const n = o.id === 'all' ? list.length : list.filter((d) => d.status === o.id).length;
      return h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(ui.filter === o.id),
        dataset: { fk: `filter-${o.id}` },
        onclick: () => { ui.filter = o.id; render(); },
      },
      o.id === 'all' ? null : h('span', { class: 'dot', dataset: { status: o.id }, 'aria-hidden': 'true' }),
      h('span', { text: o.label }),
      h('span', { class: 'chip-count', text: numFmt.format(n) }));
    }));

    const atMax = S.designs.length >= S.limits.max_designs;
    const add = $('add-designs');
    add.disabled = atMax || !!ui.uploading;
    add.title = atMax ? `Limit of ${S.limits.max_designs} designs reached. Delete some to add more.` : 'Add PNG or JPEG images';
    $('export-board').hidden = list.length === 0;
  }

  function renderUploadBar() {
    const bar = $('upload-bar');
    if (!ui.uploading) { bar.hidden = true; return; }
    const u = ui.uploading;
    bar.hidden = false;
    $('upload-text').textContent = `Adding ${numFmt.format(Math.min(u.done + 1, u.total))} of ${numFmt.format(u.total)} · ${u.name}`;
    const p = $('upload-progress');
    p.max = u.total;
    p.value = u.done;
  }

  function renderBody() {
    const body = $('board-body');
    const all = boardDesigns();
    if (all.length === 0) {
      body.replaceChildren(emptyBoard());
      return;
    }
    if (ui.view === 'compare') {
      body.replaceChildren(...compareView());
      return;
    }
    const list = visibleDesigns();
    if (list.length === 0) {
      body.replaceChildren(
        h('div', { class: 'empty-small' },
          h('h2', { class: 'empty-title', text: `No ${STATUS_LABEL[ui.filter].toLowerCase()} designs here` }),
          h('p', { class: 'empty-text', text: 'Change a design’s status from its card or detail view.' }),
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { ui.filter = 'all'; render(); $('filters').querySelector('button').focus(); } }, 'Show all designs')));
      return;
    }
    body.replaceChildren(
      h('ul', { class: 'gallery', 'aria-label': 'Designs' }, list.map((d) => designCard(d, list))));
  }

  function emptyBoard() {
    const atMax = S.designs.length >= S.limits.max_designs;
    const maxMb = Math.round(S.limits.upload_bytes / (1024 * 1024));
    return h('div', { class: 'empty' },
      h('div', { class: 'mat empty-art', 'aria-hidden': 'true' },
        h('div', { class: 'empty-sheet' }, h('span'), h('span'), h('span'))),
      h('div', { class: 'empty-copy' },
        h('h2', { class: 'empty-title', text: 'This board is empty' }),
        h('p', { class: 'empty-text', text: 'Add screenshots or mockups, mark the strongest ones, and leave notes on each. Images stay on this computer.' }),
        h('div', { class: 'empty-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', disabled: atMax, dataset: { fk: 'empty-add' }, onclick: pickFiles },
            icon('upload'), h('span', { text: 'Add your first design' })),
          h('button', { class: 'btn btn-quiet', type: 'button', disabled: atMax, dataset: { fk: 'empty-sample' }, onclick: addSample },
            icon('image'), h('span', { text: 'Use a sample image' }))),
        h('p', { class: 'empty-hint', text: `PNG or JPEG up to ${maxMb} MB. You can also drop or paste images here.` })));
  }

  /** Retry an image a few times; the local server may briefly refuse with 503 while busy. */
  function retryImage(img, giveUp) {
    let tries = 0;
    img.addEventListener('error', () => {
      const src = img.getAttribute('src');
      if (!src || tries >= 3) { giveUp(); return; }
      tries += 1;
      setTimeout(() => {
        if (img.isConnected && img.getAttribute('src') === src) {
          img.removeAttribute('src');
          img.setAttribute('src', src);
        }
      }, 300 * tries + Math.floor(Math.random() * 200));
    });
    img.addEventListener('load', () => { tries = 0; });
  }

  function matFor(d, { lazy = true } = {}) {
    const img = h('img', {
      src: d.image_url || `/media/${d.id}`,
      alt: '',
      loading: lazy ? 'lazy' : null,
      decoding: 'async',
      width: Number(d.width) > 0 ? Number(d.width) : null,
      height: Number(d.height) > 0 ? Number(d.height) : null,
      draggable: 'false',
    });
    const mat = h('span', { class: 'mat' }, img, h('span', { class: 'mat-broken', text: 'Preview unavailable' }));
    retryImage(img, () => mat.classList.add('is-broken'));
    return mat;
  }

  function statusSelect(d) {
    const title = titleOf(d, 'Untitled design');
    const select = h('select', {
      'aria-label': `Status for ${title}`,
      dataset: { fk: `status-${d.id}` },
    }, STATUSES.map((s) => h('option', { value: s.id, text: s.label })));
    select.value = d.status;
    const dot = h('span', { class: 'dot', dataset: { status: d.status }, 'aria-hidden': 'true' });
    select.addEventListener('change', () => {
      dot.dataset.status = select.value;
      setStatus(d.id, select.value);
    });
    return h('span', { class: 'status-select' }, dot, select, icon('chevronDown'));
  }

  function cardMeta(d, { dims = true } = {}) {
    const n = commentCount(d);
    return h('span', { class: 'card-meta' },
      h('span', null, icon('message'), h('span', { 'aria-hidden': 'true', text: numFmt.format(n) }), h('span', { class: 'visually-hidden', text: plural(n, 'comment', 'comments') })),
      dims && d.width && d.height ? h('span', { class: 'card-dims', text: `${d.width}×${d.height}` }) : null);
  }

  function designCard(d, list) {
    const title = titleOf(d, 'Untitled design');
    return h('li', { class: 'card' },
      h('button', {
        class: 'card-open',
        type: 'button',
        dataset: { fk: `open-${d.id}` },
        'aria-label': `${title}, ${STATUS_LABEL[d.status]}. Open details`,
        onclick: (e) => openDetail(d.id, list.map((x) => x.id), e.currentTarget),
      },
      matFor(d),
      h('span', { class: 'card-title', text: title })),
      h('div', { class: 'card-foot' }, statusSelect(d), cardMeta(d)));
  }

  function compareView() {
    const list = visibleDesigns();
    if (list.length === 0) {
      return [h('div', { class: 'empty-small' },
        h('h2', { class: 'empty-title', text: 'Nothing shortlisted yet' }),
        h('p', { class: 'empty-text', text: 'Set a design to Shortlisted or Approved and it lines up here, side by side.' }),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => setView('gallery') }, icon('grid'), h('span', { text: 'Back to gallery' })))];
    }
    const ids = list.map((x) => x.id);
    return [
      h('p', { class: 'compare-intro', text: list.length === 1
        ? 'One design is shortlisted. Shortlist another to compare.'
        : `${numFmt.format(list.length)} shortlisted and approved designs, side by side` }),
      h('ul', { class: `compare${list.length > 2 ? ' is-many' : ''}`, 'aria-label': 'Compared designs' },
        list.map((d) => {
          const title = titleOf(d, 'Untitled design');
          return h('li', { class: 'compare-col' },
            h('button', {
              class: 'card-open',
              type: 'button',
              dataset: { fk: `cmp-open-${d.id}` },
              'aria-label': `${title}, ${STATUS_LABEL[d.status]}. Open details`,
              onclick: (e) => openDetail(d.id, ids, e.currentTarget),
            }, matFor(d, { lazy: false }), h('span', { class: 'card-title', text: title })),
            h('div', { class: 'card-foot' }, statusSelect(d), cardMeta(d)));
        })),
    ];
  }

  function setView(view) {
    ui.view = view;
    render();
    $(view === 'compare' ? 'view-compare' : 'view-gallery').focus();
  }

  // ---------- Board actions ----------

  async function newBoard() {
    if (S.boards.length >= S.limits.max_boards) {
      toast(`You can have up to ${S.limits.max_boards} boards.`, { error: true });
      return;
    }
    const title = await promptText({ title: 'New board', label: 'Board name', value: '', submit: 'Create board' });
    if (title == null) return;
    const res = await mutate(() => api('POST', '/api/boards', { json: { title } }), { success: 'Board created' });
    if (res && res.board && res.board.id) {
      if ($('dlg-boards').open) $('dlg-boards').close();
      selectBoard(res.board.id);
    }
  }

  async function renameBoard() {
    const board = currentBoard();
    if (!board) return;
    const title = await promptText({ title: 'Rename board', label: 'Board name', value: titleOf(board, ''), submit: 'Save' });
    if (title == null || title === board.title) return;
    await mutate(() => api('PATCH', `/api/boards/${board.id}`, { json: { title } }), { success: 'Board renamed' });
  }

  async function deleteBoard() {
    const board = currentBoard();
    if (!board) return;
    const designs = boardDesigns();
    const comments = designs.reduce((n, d) => n + commentCount(d), 0);
    const what = designs.length
      ? `This deletes ${plural(designs.length, 'design', 'designs')} and ${plural(comments, 'comment', 'comments')} from this computer. Export the board first if you want a copy.`
      : 'This board has no designs. It will be removed.';
    const ok = await confirmAction({ title: `Delete “${titleOf(board, 'Untitled board')}”?`, text: what, confirm: 'Delete board' });
    if (!ok) return;
    const res = await mutate(() => api('DELETE', `/api/boards/${board.id}`), { success: 'Board deleted' });
    if (res) {
      history.replaceState(null, '', ui.boardId && S.boards.some((b) => b.id === ui.boardId) ? `#board/${ui.boardId}` : location.pathname);
      $('board-title').focus({ preventScroll: true });
    }
  }

  // ---------- Uploads ----------

  function pickFiles() {
    if (!ui.boardId || ui.uploading) return;
    const input = $('file-input');
    input.value = '';
    input.click();
  }

  function guessType(file) {
    if (ACCEPT_TYPES.includes(file.type)) return file.type;
    const name = (file.name || '').toLowerCase();
    if (/\.png$/.test(name)) return 'image/png';
    if (/\.jpe?g$/.test(name)) return 'image/jpeg';
    return null;
  }

  function titleFromFile(name) {
    const base = stripControl(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return clip(base || 'Untitled design', TITLE_MAX).trim() || 'Untitled design';
  }

  async function uploadFiles(fileList) {
    const boardId = ui.boardId;
    if (!boardId || ui.uploading) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const room = Math.max(0, S.limits.max_designs - S.designs.length);
    const accepted = [];
    const problems = [];
    for (const f of files) {
      const type = guessType(f);
      if (!type) { problems.push(`${f.name || 'A file'} isn’t a PNG or JPEG`); continue; }
      if (f.size > S.limits.upload_bytes) { problems.push(`${f.name || 'An image'} is over ${formatBytes(S.limits.upload_bytes)}`); continue; }
      if (f.size === 0) { problems.push(`${f.name || 'An image'} is empty`); continue; }
      if (accepted.length >= room) { problems.push(`Design limit of ${S.limits.max_designs} reached`); break; }
      accepted.push({ file: f, type, title: titleFromFile(f.name) });
    }
    problems.slice(0, 3).forEach((p) => toast(p, { error: true }));
    if (!accepted.length) return;

    ui.uploading = { done: 0, total: accepted.length, name: accepted[0].title };
    ui.pending += 1;
    render();
    let added = 0;
    for (const item of accepted) {
      ui.uploading.name = item.title;
      renderUploadBar();
      try {
        await api('POST', `/api/boards/${boardId}/designs?title=${encodeURIComponent(item.title)}`, { body: item.file, type: item.type });
        added += 1;
        ui.failed = false;
      } catch (err) {
        ui.failed = true;
        toast(`${item.title}: ${err.message}`, { error: true });
        if (err.status === 0 || err.status === 404) break;
      }
      ui.uploading.done += 1;
      renderUploadBar();
    }
    ui.uploading = null;
    ui.pending -= 1;
    if (added && ui.view === 'gallery' && ui.filter !== 'all' && ui.filter !== 'exploring') ui.filter = 'all';
    await loadState({ quiet: true });
    if (added) toast(added === 1 ? 'Design added' : `${numFmt.format(added)} designs added`);
  }

  /** Draws a synthetic layout sketch with canvas so the empty state can be tried without any files. */
  function addSample() {
    const palettes = [
      { paper: '#f4f1ea', ink: '#22231f', a: '#d9643a', b: '#2f5d8a', c: '#e9c46a' },
      { paper: '#eef1f4', ink: '#1d2430', a: '#3c6e5a', b: '#c7553f', c: '#a8c3d6' },
      { paper: '#f6f2f4', ink: '#2a2027', a: '#7a4d8c', b: '#e0a93b', c: '#d7c4cf' },
    ];
    const pal = palettes[Math.floor(Math.random() * palettes.length)];
    const W = 1600;
    const H = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.toBlob) { toast('This browser can’t draw a sample image.', { error: true }); return; }

    const rr = (x, y, w, hgt, r, fill) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + hgt, r);
      ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
      ctx.arcTo(x, y + hgt, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };

    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, W, H);
    // nav
    rr(96, 80, 120, 28, 6, pal.ink);
    for (let i = 0; i < 4; i += 1) rr(900 + i * 140, 88, 96, 14, 7, 'rgba(0,0,0,0.18)');
    // headline blocks
    rr(96, 220, 620, 64, 8, pal.ink);
    rr(96, 304, 520, 64, 8, pal.ink);
    rr(96, 408, 460, 18, 9, 'rgba(0,0,0,0.22)');
    rr(96, 440, 400, 18, 9, 'rgba(0,0,0,0.22)');
    rr(96, 512, 200, 56, 28, pal.a);
    rr(316, 512, 160, 56, 28, 'rgba(0,0,0,0.08)');
    // illustration panel
    rr(800, 200, 704, 520, 20, pal.c);
    ctx.save();
    ctx.beginPath();
    ctx.rect(800, 200, 704, 520);
    ctx.clip();
    ctx.fillStyle = pal.a;
    ctx.beginPath();
    ctx.arc(1320, 360, 84, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pal.b;
    ctx.beginPath();
    ctx.moveTo(800, 720);
    ctx.bezierCurveTo(960, 520, 1080, 540, 1180, 620);
    ctx.bezierCurveTo(1280, 700, 1400, 520, 1504, 580);
    ctx.lineTo(1504, 720);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // cards row
    for (let i = 0; i < 3; i += 1) {
      const x = 96 + i * 480;
      rr(x, 800, 448, 300, 16, '#ffffff');
      rr(x + 32, 832, 56, 56, 12, [pal.a, pal.b, pal.c][i]);
      rr(x + 32, 920, 260, 22, 11, pal.ink);
      rr(x + 32, 960, 360, 14, 7, 'rgba(0,0,0,0.16)');
      rr(x + 32, 988, 320, 14, 7, 'rgba(0,0,0,0.16)');
      rr(x + 32, 1016, 220, 14, 7, 'rgba(0,0,0,0.16)');
    }

    const finish = (blob) => {
      if (!blob) { toast('Couldn’t create the sample image.', { error: true }); return; }
      const n = boardDesigns().filter((d) => /^Sample layout/.test(d.title || '')).length + 1;
      const file = new File([blob], `Sample layout ${n}.png`, { type: 'image/png' });
      uploadFiles([file]);
    };
    if (typeof CompressionStream === 'function') {
      encodePng(ctx.getImageData(0, 0, W, H)).then(finish, () => canvas.toBlob(finish, 'image/png'));
    } else {
      canvas.toBlob(finish, 'image/png');
    }
  }

  // Minimal PNG encoder: 8-bit RGBA (color type 6), non-interlaced, filter 0, zlib from
  // CompressionStream('deflate'). Only IHDR, IDAT and IEND, so the server's strict check accepts it.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  async function encodePng(imageData) {
    const { width, height, data } = imageData;
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
      raw[y * (stride + 1)] = 0; // row filter: none
      raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    const zlib = new Uint8Array(await new Response(stream).arrayBuffer());
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    // bytes 10-12 stay 0: deflate, adaptive filtering, no interlace
    const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new Blob([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib), pngChunk('IEND', new Uint8Array(0))],
      { type: 'image/png' });
  }

  // ---------- Design actions ----------

  async function setStatus(id, status) {
    const d = findDesign(id);
    if (!d || d.status === status || !STATUS_LABEL[status]) return;
    await mutate(() => api('PATCH', `/api/designs/${id}`, { json: { status } }), { success: `Marked ${STATUS_LABEL[status].toLowerCase()}` });
  }

  async function renameDesign(id) {
    const d = findDesign(id);
    if (!d) return;
    const title = await promptText({ title: 'Rename design', label: 'Design name', value: titleOf(d, ''), submit: 'Save' });
    if (title == null || title === d.title) return;
    await mutate(() => api('PATCH', `/api/designs/${id}`, { json: { title } }), { success: 'Design renamed' });
  }

  async function deleteDesign(id) {
    const d = findDesign(id);
    if (!d) return;
    const n = commentCount(d);
    const ok = await confirmAction({
      title: `Delete “${titleOf(d, 'Untitled design')}”?`,
      text: n ? `The image and its ${plural(n, 'comment', 'comments')} will be removed from this computer.` : 'The image will be removed from this computer.',
      confirm: 'Delete design',
    });
    if (!ok) return;
    const idx = ui.detailList.indexOf(id);
    const res = await mutate(() => api('DELETE', `/api/designs/${id}`), { success: 'Design deleted' });
    if (!res) return;
    if (ui.detailId === id) {
      const remaining = ui.detailList.filter((x) => x !== id && findDesign(x));
      if (remaining.length) {
        ui.detailList = remaining;
        showDetail(remaining[Math.min(idx, remaining.length - 1)]);
      } else {
        closeDetail();
      }
    }
  }

  // ---------- Detail ----------

  function openDetail(id, list, opener) {
    ui.detailList = list && list.length ? list.slice() : [id];
    ui.zoom = false;
    ui.replyTo = null;
    const dlg = $('dlg-detail');
    showDetail(id);
    if (!dlg.open) openDialog(dlg, opener);
    $('detail-close').focus();
  }

  function showDetail(id) {
    if (ui.detailId !== id) {
      ui.replyTo = null;
      $('composer-text').value = '';
    }
    ui.detailId = id;
    renderDetail();
  }

  function closeDetail() {
    const dlg = $('dlg-detail');
    ui.detailId = null;
    ui.replyTo = null;
    if (dlg.open) dlg.close();
  }

  function stepDetail(delta) {
    const list = ui.detailList.filter((x) => findDesign(x));
    const i = list.indexOf(ui.detailId);
    const next = list[i + delta];
    if (next) {
      ui.zoom = false;
      showDetail(next);
    }
  }

  function renderDetail() {
    const d = findDesign(ui.detailId);
    if (!d) return;
    const title = titleOf(d, 'Untitled design');
    $('detail-title').textContent = title;

    // Stage
    const img = $('detail-img');
    const broken = $('detail-broken');
    const src = d.image_url || `/media/${d.id}`;
    if (img.getAttribute('src') !== src) {
      img.hidden = false;
      broken.hidden = true;
      img.setAttribute('src', src);
    }
    img.alt = title;
    if (d.width && d.height) { img.width = Number(d.width); img.height = Number(d.height); }
    const canvas = $('stage-canvas');
    canvas.classList.toggle('is-actual', ui.zoom);
    canvas.setAttribute('aria-label', `Preview of ${title}${ui.zoom ? ', actual size, scroll to pan' : ''}`);
    const zoom = $('detail-zoom');
    zoom.setAttribute('aria-pressed', String(ui.zoom));
    $('detail-zoom-label').textContent = ui.zoom ? 'Fit to screen' : 'Actual size';
    const zIcon = zoom.querySelector('[data-icon]');
    zIcon.replaceChildren(icon(ui.zoom ? 'minimize' : 'maximize'));
    $('detail-open-file').href = src;

    const list = ui.detailList.filter((x) => findDesign(x));
    const i = list.indexOf(d.id);
    $('detail-count').textContent = list.length > 1 ? `${numFmt.format(i + 1)} of ${numFmt.format(list.length)}` : '';
    $('detail-prev').disabled = i <= 0;
    $('detail-next').disabled = i < 0 || i >= list.length - 1;

    // Status
    const row = $('detail-status');
    if (!row.childElementCount) {
      row.replaceChildren(...STATUSES.map((s) => {
        const input = h('input', { type: 'radio', name: 'detail-status', id: `ds-${s.id}`, value: s.id });
        input.addEventListener('change', () => { if (input.checked && ui.detailId) setStatus(ui.detailId, s.id); });
        return h('span', { class: 'radio-opt' }, input,
          h('label', { for: `ds-${s.id}` }, h('span', { class: 'dot', dataset: { status: s.id }, 'aria-hidden': 'true' }), h('span', { text: s.label })));
      }));
    }
    row.querySelectorAll('input').forEach((input) => { input.checked = input.value === d.status; });

    // Meta
    const board = S.boards.find((b) => b.id === d.board_id);
    const meta = [];
    if (d.width && d.height) meta.push(['Size', h('span', { class: 'mono', text: `${numFmt.format(d.width)} × ${numFmt.format(d.height)} px` })]);
    if (d.bytes) meta.push(['File', h('span', { class: 'mono', text: formatBytes(d.bytes) })]);
    const added = toDate(d.created_at);
    if (added) meta.push(['Added', h('time', { datetime: added.toISOString(), text: fullFmt.format(added) })]);
    if (board) meta.push(['Board', h('span', { text: titleOf(board, 'Untitled board') })]);
    $('detail-meta').replaceChildren(...meta.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]));

    renderComments(d);
  }

  function renderComments(d) {
    const tops = d.comments.filter((c) => !c.parent_id);
    const byParent = new Map();
    for (const c of d.comments) {
      if (!c.parent_id) continue;
      if (!byParent.has(c.parent_id)) byParent.set(c.parent_id, []);
      byParent.get(c.parent_id).push(c);
    }
    const t = (x) => (toDate(x.created_at) || new Date(0)).getTime();
    tops.sort((a, b) => t(a) - t(b));
    byParent.forEach((arr) => arr.sort((a, b) => t(a) - t(b)));

    const total = d.comments.length;
    $('comments-title').replaceChildren('Comments', total ? h('span', { class: 'comments-count', text: numFmt.format(total) }) : null);

    const list = $('thread-list');
    // Keep an in-progress reply draft across re-renders.
    const draftEl = list.querySelector('.reply-form textarea');
    const replyDraft = draftEl ? draftEl.value : '';
    const replyHadFocus = draftEl && document.activeElement === draftEl;

    if (!tops.length) {
      list.replaceChildren(h('p', { class: 'thread-empty', text: 'No comments yet. Note what works and what should change.' }));
      return;
    }
    if (ui.replyTo && !tops.some((c) => c.id === ui.replyTo)) ui.replyTo = null;

    list.replaceChildren(...tops.map((c) => {
      const replies = byParent.get(c.id) || [];
      const thread = h('article', { class: 'thread', 'aria-label': 'Comment thread' },
        commentNode(c, { isTop: true, replyCount: replies.length }),
        replies.length ? h('div', { class: 'replies' }, replies.map((r) => commentNode(r, { isTop: false }))) : null);
      if (ui.replyTo === c.id) thread.append(replyForm(c, replyDraft));
      return thread;
    }));

    if (replyHadFocus) {
      const ta = list.querySelector('.reply-form textarea');
      if (ta) ta.focus({ preventScroll: true });
    }
  }

  function commentNode(c, { isTop, replyCount = 0 }) {
    return h('div', { class: 'comment' },
      h('p', { class: 'comment-text', text: typeof c.text === 'string' ? c.text : '' }),
      h('div', { class: 'comment-meta' },
        timeEl(c.created_at),
        isTop ? h('button', {
          class: 'comment-action',
          type: 'button',
          dataset: { fk: `reply-${c.id}` },
          'aria-expanded': String(ui.replyTo === c.id),
          onclick: () => startReply(c.id),
        }, icon('reply'), h('span', { text: 'Reply' })) : null,
        h('button', {
          class: 'comment-action is-danger',
          type: 'button',
          dataset: { fk: `del-${c.id}` },
          'aria-label': isTop && replyCount ? `Delete comment and ${plural(replyCount, 'reply', 'replies')}` : (isTop ? 'Delete comment' : 'Delete reply'),
          onclick: () => deleteComment(c, isTop, replyCount),
        }, icon('trash'), h('span', { text: 'Delete' }))));
  }

  function replyForm(parent, draft) {
    const ta = h('textarea', {
      class: 'textarea',
      id: `reply-text-${parent.id}`,
      rows: '2',
      maxlength: String(COMMENT_MAX),
      placeholder: 'Write a reply',
      'aria-label': 'Reply',
      value: draft || '',
    });
    const form = h('form', { class: 'reply-form', novalidate: true },
      ta,
      h('div', { class: 'reply-actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: cancelReply }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Reply')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      postComment(ta, parent.id);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postComment(ta, parent.id); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelReply(); }
    });
    return form;
  }

  function startReply(id) {
    ui.replyTo = ui.replyTo === id ? null : id;
    const d = findDesign(ui.detailId);
    if (!d) return;
    renderComments(d);
    if (ui.replyTo) {
      const ta = document.getElementById(`reply-text-${id}`);
      if (ta) ta.focus();
    } else {
      const btn = document.querySelector(`[data-fk="reply-${CSS.escape(id)}"]`);
      if (btn) btn.focus();
    }
  }

  function cancelReply() {
    const id = ui.replyTo;
    ui.replyTo = null;
    const d = findDesign(ui.detailId);
    if (d) renderComments(d);
    const btn = id && document.querySelector(`[data-fk="reply-${CSS.escape(id)}"]`);
    if (btn) btn.focus();
  }

  let posting = false;
  async function postComment(textarea, parentId) {
    const text = stripControl(textarea.value).trim();
    const designId = ui.detailId;
    if (!text) {
      textarea.focus();
      toast(parentId ? 'Write a reply first.' : 'Write a comment first.', { error: true });
      return;
    }
    if (charLen(text) > COMMENT_MAX) {
      textarea.focus();
      toast(`Keep ${parentId ? 'replies' : 'comments'} to ${numFmt.format(COMMENT_MAX)} characters or fewer.`, { error: true });
      return;
    }
    if (posting || !designId) return;
    posting = true;
    textarea.setAttribute('aria-busy', 'true');
    const res = await mutate(() => api('POST', `/api/designs/${designId}/comments`, { json: { text, parent_id: parentId || null } }), {
      success: parentId ? 'Reply added' : 'Comment added',
      refresh: false,
    });
    posting = false;
    textarea.removeAttribute('aria-busy');
    if (!res) return;
    if (parentId) {
      ui.replyTo = null;
      textarea.value = '';
    } else {
      $('composer-text').value = '';
    }
    await loadState({ quiet: true });
    if (parentId) {
      const btn = document.querySelector(`[data-fk="reply-${CSS.escape(parentId)}"]`);
      if (btn) btn.focus();
    } else {
      $('composer-text').focus();
    }
  }

  async function deleteComment(c, isTop, replyCount) {
    const ok = await confirmAction({
      title: isTop ? 'Delete comment?' : 'Delete reply?',
      text: isTop && replyCount
        ? `This comment and its ${plural(replyCount, 'reply', 'replies')} will be removed.`
        : `This ${isTop ? 'comment' : 'reply'} will be removed.`,
      confirm: 'Delete',
    });
    if (!ok) return;
    if (ui.replyTo === c.id) ui.replyTo = null;
    const res = await mutate(() => api('DELETE', `/api/comments/${c.id}`), { success: isTop ? 'Comment deleted' : 'Reply deleted' });
    if (res) $('composer-text').focus({ preventScroll: true });
  }

  // ---------- Dialog helpers ----------

  function openDialog(dlg, opener) {
    dlg._opener = opener || document.activeElement;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function restoreFocus(dlg) {
    const opener = dlg._opener;
    dlg._opener = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function' && !opener.closest('[hidden]')) {
      opener.focus({ preventScroll: true });
      return;
    }
    // Opener was re-rendered; try its focus key, else the board title.
    const key = opener && opener.dataset ? opener.dataset.fk : null;
    const byKey = key && document.querySelector(`[data-fk="${CSS.escape(key)}"]`);
    if (byKey) { byKey.focus({ preventScroll: true }); return; }
    const top = document.querySelector('dialog[open]');
    if (top) return;
    const title = $('board-title');
    if (title && !$('view-board').hidden) title.focus({ preventScroll: true });
  }

  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('close', () => restoreFocus(dlg));
    dlg.addEventListener('click', (e) => {
      // Click on the backdrop closes small dialogs (not the full-screen detail).
      if (e.target === dlg && dlg.classList.contains('sheet')) dlg.close('cancel');
    });
    dlg.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => dlg.close('cancel')));
  });

  function promptText({ title, label, value, submit }) {
    const dlg = $('dlg-text');
    const form = $('text-form');
    const input = $('text-input');
    const error = $('text-error');
    $('text-title').textContent = title;
    $('text-label').textContent = label;
    $('text-submit').textContent = submit || 'Save';
    input.value = value || '';
    input.maxLength = TITLE_MAX;
    input.removeAttribute('aria-invalid');
    error.textContent = '';
    return new Promise((resolve) => {
      let result = null;
      const onSubmit = (e) => {
        e.preventDefault();
        const v = stripControl(input.value).replace(/\s+/g, ' ').trim();
        if (!v || charLen(v) > TITLE_MAX) {
          input.setAttribute('aria-invalid', 'true');
          error.textContent = v ? `Use ${TITLE_MAX} characters or fewer.` : 'Enter a name.';
          input.focus();
          return;
        }
        result = v;
        dlg.close('ok');
      };
      const onClose = () => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        resolve(result);
      };
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      openDialog(dlg);
      input.focus();
      input.select();
    });
  }

  function confirmAction({ title, text, confirm }) {
    const dlg = $('dlg-confirm');
    const form = $('confirm-form');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-submit').textContent = confirm || 'Delete';
    return new Promise((resolve) => {
      let ok = false;
      const onSubmit = (e) => {
        e.preventDefault();
        ok = true;
        dlg.close('ok');
      };
      const onClose = () => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        resolve(ok);
      };
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      openDialog(dlg);
      // Safe default: focus lands on Cancel, not on the destructive action.
      $('confirm-cancel').focus();
    });
  }

  // ---------- Reset ----------

  function openReset(opener) {
    const dlg = $('dlg-reset');
    const input = $('reset-input');
    input.value = '';
    $('reset-submit').disabled = true;
    if ($('dlg-boards').open) $('dlg-boards').close();
    openDialog(dlg, opener);
    input.focus();
  }

  $('reset-input').addEventListener('input', (e) => {
    $('reset-submit').disabled = e.target.value.trim().toUpperCase() !== 'DELETE';
  });

  $('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('reset-input').value.trim().toUpperCase() !== 'DELETE') return;
    const btn = $('reset-submit');
    btn.disabled = true;
    const res = await mutate(() => api('POST', '/api/reset', { json: { confirm: 'DELETE ALL LOCAL DATA' } }), { refresh: false });
    if (!res) { btn.disabled = false; return; }
    $('dlg-reset').close('ok');
    closeDetail();
    ui.boardId = null;
    ui.view = 'gallery';
    ui.filter = 'all';
    ui.bootstrapTried = false;
    history.replaceState(null, '', location.pathname);
    await loadState({ quiet: true });
    toast('All local data deleted');
    $('board-title').focus({ preventScroll: true });
  });

  // ---------- Drag, drop and paste ----------

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const canAcceptDrop = () => !!ui.boardId && !ui.uploading && !document.querySelector('dialog[open]') && !$('view-board').hidden;

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !canAcceptDrop()) return;
    e.preventDefault();
    dragDepth += 1;
    const board = currentBoard();
    $('drop-text').textContent = `Drop images to add them to ${titleOf(board, 'this board')}`;
    $('drop-overlay').hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = canAcceptDrop() ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-overlay').hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    if (canAcceptDrop()) uploadFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    if (!canAcceptDrop()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => guessType(f));
    if (!files.length) return;
    e.preventDefault();
    const named = files.map((f, i) => (f.name && f.name !== 'image.png'
      ? f
      : new File([f], `Pasted image ${i + 1}.${f.type === 'image/jpeg' ? 'jpg' : 'png'}`, { type: f.type })));
    uploadFiles(named);
  });

  // ---------- Static wiring ----------

  $('file-input').addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) uploadFiles(files);
  });
  $('add-designs').addEventListener('click', pickFiles);
  $('new-board').addEventListener('click', newBoard);
  $('new-board-sheet').addEventListener('click', newBoard);
  $('rename-board').addEventListener('click', renameBoard);
  $('delete-board').addEventListener('click', deleteBoard);
  $('view-gallery').addEventListener('click', () => setView('gallery'));
  $('view-compare').addEventListener('click', () => setView('compare'));
  $('retry').addEventListener('click', () => loadState());
  $('reset-open').addEventListener('click', (e) => openReset(e.currentTarget));
  $('reset-open-sheet').addEventListener('click', () => openReset($('boards-toggle')));
  $('boards-toggle').addEventListener('click', (e) => {
    openDialog($('dlg-boards'), e.currentTarget);
    const current = $('board-list-sheet').querySelector('[aria-current="page"]');
    if (current) current.focus();
  });

  // Detail
  $('detail-close').addEventListener('click', closeDetail);
  $('detail-prev').addEventListener('click', () => stepDetail(-1));
  $('detail-next').addEventListener('click', () => stepDetail(1));
  $('detail-zoom').addEventListener('click', () => {
    ui.zoom = !ui.zoom;
    renderDetail();
    if (ui.zoom) $('stage-canvas').scrollTo(0, 0);
  });
  $('detail-rename').addEventListener('click', () => ui.detailId && renameDesign(ui.detailId));
  $('detail-delete').addEventListener('click', () => ui.detailId && deleteDesign(ui.detailId));
  retryImage($('detail-img'), () => {
    $('detail-img').hidden = true;
    $('detail-broken').hidden = false;
  });
  $('detail-img').addEventListener('load', () => {
    $('detail-img').hidden = false;
    $('detail-broken').hidden = true;
  });
  $('dlg-detail').addEventListener('close', () => {
    ui.detailId = null;
    ui.replyTo = null;
  });
  $('dlg-detail').addEventListener('cancel', (e) => {
    // Esc first closes an open reply form, then the detail view.
    if (ui.replyTo) {
      e.preventDefault();
      cancelReply();
    }
  });
  $('dlg-detail').addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT');
    if (typing) return;
    if (ui.zoom && t && t.id === 'stage-canvas') return; // arrows pan the zoomed image
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepDetail(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepDetail(1); }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    postComment($('composer-text'), null);
  });
  $('composer-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      postComment($('composer-text'), null);
    }
  });

  // Keep relative times fresh while the page is open.
  setInterval(() => {
    document.querySelectorAll('time[datetime]').forEach((el) => {
      if (el.closest('.meta-list')) return;
      const v = el.getAttribute('datetime');
      const next = relTime(v);
      if (next && el.textContent !== next) el.textContent = next;
    });
  }, 60000);

  // ---------- Boot ----------

  hydrateIcons();
  setSaveState();
  loadState();
})();
