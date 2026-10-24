/* BOSS-ARMY Downloader page.
   Flow: paste a release ID -> /album -> one row per track -> paste a YouTube link in a row
   (/linkinfo checks it) -> download via the background queue (/queue) -> poll for progress. */
(() => {
  'use strict';

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const URL_RE = /^https?:\/\/\S+$/;
  const MATCH_SECONDS = 5;          // video length may differ from the album by this much
  const POLL_MS = 1200;
  const COMMON_GENRES = [
    'Pop', 'Rock', 'Hip Hop', 'R&B', 'Soul', 'Funk', 'Jazz', 'Blues', 'Classical', 'Electronic', 'Dance',
    'House', 'Techno', 'Trance', 'Drum and Bass', 'Dubstep', 'Ambient', 'Lo-Fi', 'Disco', 'Metal', 'Punk',
    'Alternative', 'Indie', 'Folk', 'Country', 'Reggae', 'Dancehall', 'Afrobeats', 'Gospel', 'Latin',
    'K-Pop', 'J-Pop', 'Anime', 'Soundtrack', 'Vocaloid', 'World', 'Children\'s',
  ];
  // Offered when MusicBrainz knows few or no genres for an album
  const QUICK_GENRES = ['Pop', 'Rock', 'Hip Hop', 'R&B', 'Electronic', 'J-Pop', 'Anime', 'Soundtrack'];

  const $ = (sel, root = document) => root.querySelector(sel);

  const ICON = {
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    alert: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l6.2 10.8H1.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.6v3M8 11.3v.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    dash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    wait: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12.5 12.5L17 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };

  const els = {
    start: $('#start'), releaseInput: $('#release-input'), startMsg: $('#start-msg'),
    banner: $('#active-banner'), bannerText: $('#active-text'),
    albums: $('#albums'), albumsList: $('#albums-list'), albumsToggle: $('#albums-toggle'),
    albumsBody: $('#albums-body'), albumsCount: $('#albums-count'), albumsSearch: $('#albums-search'), albumsNone: $('#albums-none'),
    history: $('#history'), histActive: $('#hist-active'), histActiveList: $('#hist-active-list'),
    histList: $('#hist-list'), histEmpty: $('#hist-empty'), histFilters: $('#history .hist-filters'),
    album: $('#album'), heroBg: $('#hero-bg'), coverWrap: $('#cover-wrap'), cover: $('#cover'),
    title: $('#album-title'), artist: $('#album-artist'), facts: $('#album-facts'),
    summary: $('#album-summary'), change: $('#change-album'), tracks: $('#tracks'),
    bar: $('#bar'), barCount: $('#bar-count'), barQueue: $('#bar-queue'),
    barGo: $('#bar-go'), barCancel: $('#bar-cancel'), toasts: $('#toasts'),
    findBtn: $('#find-btn'), findLabel: $('#find-label'), findHint: $('#find-hint'),
    genreHint: $('#genre-hint'), genreChips: $('#genre-chips'), genreInput: $('#genre-input'),
    genreList: $('#genre-list'), genreAdd: $('#genre-add'), genreApply: $('#genre-apply'),
    genreApplyText: $('#genre-apply-text'), genreApplyBtn: $('#genre-apply-btn'),
  };

  // ------------------------------------------------------------------ state
  const S = {
    id: null,            // release shown now
    album: null,
    rows: new Map(),     // "disc-track" -> row
    pollTimer: null,
    loadToken: 0,
    loadingId: null,
    pending: null,       // from the history page: { id, key, url } to show once that album has loaded
    histRows: [], histFilter: 'all', histTimer: null, histActiveCount: 0,
    genre: null,         // { suggestions, chosen (null = nothing chosen yet), extras, loading, ready, saveTimer }
  };

  // ------------------------------------------------------------------ helpers
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage may be blocked */ }
    },
  };

  function fmtTime(sec) {
    if (sec == null) return '–';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
             : `${m}:${String(s).padStart(2, '0')}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const span = document.createElement('span');
    span.style.display = 'contents';
    span.innerHTML = ICON[name];          // our own constants, never user text
    return span.firstChild;
  }

  function spinner() { return el('span', 'spinner'); }

  function toast(message, kind) {
    const t = el('div', 'toast' + (kind === 'error' ? ' is-error' : ''), message);
    const remove = () => t.remove();
    t.addEventListener('click', remove);
    els.toasts.append(t);
    setTimeout(remove, kind === 'error' ? 7000 : 3500);
  }

  async function getJSON(url, options) {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    return { ok: res.ok, data };
  }

  // ------------------------------------------------------------------ cover colour
  function pickAccent(img) {
    // Look at a tiny copy of the cover and pick its most colourful hue.
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    const bins = Array.from({ length: 12 }, () => ({ w: 0, hw: 0, sw: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2, d = max - min;
      if (d < 0.08 || l < 0.12 || l > 0.92) continue;       // grey, black or white: no colour to use
      const s = d / (1 - Math.abs(2 * l - 1));
      let h;
      if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const w = s * (1 - Math.abs(l - 0.5));
      const bin = bins[Math.min(11, Math.floor(h / 30))];
      bin.w += w; bin.hw += w * h; bin.sw += w * s;
    }
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w < 1) return null;
    return { h: Math.round(best.hw / best.w), s: Math.round(Math.min(0.9, Math.max(0.5, best.sw / best.w)) * 100) };
  }

  function applyAccent(img) {
    try {
      const a = pickAccent(img);
      if (a) document.documentElement.style.setProperty('--accent', `hsl(${a.h} ${a.s}% 68%)`);
      else resetAccent();
    } catch (e) { resetAccent(); }
  }

  function resetAccent() { document.documentElement.style.removeProperty('--accent'); }

  // ------------------------------------------------------------------ screens
  function showScreen(name) {
    els.start.hidden = name !== 'start';
    els.album.hidden = name !== 'album';
    els.history.hidden = name !== 'history';
    els.bar.hidden = name !== 'album';
    if (name !== 'history') stopHistoryPolling();
    document.querySelectorAll('.topnav [data-nav]').forEach((link) => {
      const here = (name === 'history' && link.dataset.nav === 'history') ||
                   (name !== 'history' && link.dataset.nav === 'albums');
      if (here) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
  }

  function setStartMsg(text, kind) {
    els.startMsg.replaceChildren();
    els.startMsg.className = 'start-msg' + (kind === 'error' ? ' is-error' : '');
    if (kind === 'busy') els.startMsg.append(spinner());
    els.startMsg.append(document.createTextNode(text));
  }

  function showStart() {
    stopPolling();
    S.id = null; S.album = null; S.rows = new Map();
    resetAccent();
    els.releaseInput.value = '';
    setStartMsg('');
    showScreen('start');
    loadAlbumsList();
    loadActiveBanner();
    els.releaseInput.focus();
  }

  // ------------------------------------------------------------------ start screen
  function parseRelease(raw) {
    const text = raw.trim();
    if (!text) return { kind: 'empty' };
    const m = text.match(UUID_RE);
    if (!m) return { kind: text.length >= 30 ? 'bad' : 'wait' };
    const typed = text.match(new RegExp('([a-z-]+)/' + m[0], 'i'));
    if (typed && typed[1].toLowerCase() !== 'release') return { kind: 'wrong', type: typed[1].toLowerCase() };
    return { kind: 'ok', id: m[0].toLowerCase() };
  }

  function onStartInput() {
    const r = parseRelease(els.releaseInput.value);
    if (r.kind === 'ok') {
      if (S.loadingId !== r.id) loadAlbum(r.id);
    } else if (r.kind === 'wrong') {
      setStartMsg(`That link is for a ${r.type.replace('-', ' ')}, not a release. Open one edition of the album and copy its link.`, 'error');
    } else if (r.kind === 'bad') {
      setStartMsg('That does not look like a MusicBrainz release link or ID.', 'error');
    } else {
      setStartMsg('');
    }
  }

  // ------------------------------------------------------------------ your albums
  function timeAgo(seconds) {
    const diff = Math.max(0, Date.now() / 1000 - seconds);
    if (diff < 90) return 'just now';
    if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
    if (diff < 86400 * 2) return 'yesterday';
    return `${Math.round(diff / 86400)} days ago`;
  }

  async function loadAlbumsList() {
    let result;
    try { result = await getJSON('/albums'); } catch (e) { return; }
    if (!result.ok || !els.history.hidden) return;
    S.albumsAll = result.data.albums || [];
    renderAlbums();
  }

  function setAlbumsOpen(open) {
    els.albumsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    els.albumsBody.hidden = !open;
    store.set('ba_albums_open', open);
    if (open) els.albumsSearch.focus({ preventScroll: true });
  }

  function renderAlbums() {
    const all = S.albumsAll || [];
    const q = els.albumsSearch.value.trim().toLowerCase();
    const list = q ? all.filter((a) => `${a.title} ${a.artist}`.toLowerCase().includes(q)) : all;
    els.albums.hidden = all.length === 0;
    els.albumsCount.textContent = all.length;
    els.albumsNone.hidden = list.length > 0 || all.length === 0;
    els.albumsList.replaceChildren(...list.map((a) => {
      const li = el('li', 'album-item');
      const open = el('button', 'album-open');
      open.type = 'button';

      const cover = el('span', 'album-cover');
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      img.onload = () => { const n = cover.querySelector('svg'); if (n) n.remove(); };
      img.src = '/cover?id=' + encodeURIComponent(a.release_id);
      cover.append(icon('note'), img);

      const text = el('span', 'album-text');
      const name = el('div', 'album-name', a.title);
      name.title = a.title;
      const progress = el('div', 'album-progress' + (a.have_count >= a.track_count && a.track_count ? ' is-complete' : ''));
      if (a.track_count && a.have_count >= a.track_count) {
        progress.append(icon('check'), document.createTextNode('Complete'));
      } else {
        const bar = el('span', 'pbar');
        const fill = el('span', 'pfill');
        fill.style.width = (a.track_count ? Math.round((100 * a.have_count) / a.track_count) : 0) + '%';
        bar.append(fill);
        progress.append(bar, document.createTextNode(`${a.have_count} of ${a.track_count} saved`));
      }
      text.append(name, el('div', 'album-by', a.artist), progress);

      open.append(cover, text, el('span', 'album-when', timeAgo(a.last_opened)));
      open.addEventListener('click', () => { history.pushState(null, '', '#' + a.release_id); loadAlbum(a.release_id); });

      const forget = el('button', 'album-forget');
      forget.type = 'button';
      forget.title = 'Remove from this list';
      forget.setAttribute('aria-label', `Remove ${a.title} from this list`);
      forget.append(icon('cross'));
      forget.addEventListener('click', async () => {
        try {
          await getJSON('/albums/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ release: a.release_id }) });
        } catch (e) { toast('Could not reach the downloader.', 'error'); return; }
        li.remove();
        S.albumsAll = (S.albumsAll || []).filter((x) => x.release_id !== a.release_id);
        renderAlbums();
      });
      li.append(open, forget);
      return li;
    }));
  }

  async function loadActiveBanner() {
    let result;
    try { result = await getJSON('/queue'); } catch (e) { return; }
    if (!result.ok) return;
    const { running, waiting } = result.data;
    els.banner.hidden = running + waiting === 0;
    els.bannerText.textContent = [running ? `${running} downloading` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(', ');
  }

  // ------------------------------------------------------------------ history page
  function stopHistoryPolling() {
    if (S.histTimer) clearTimeout(S.histTimer);
    S.histTimer = null;
  }

  async function showHistory() {
    stopPolling();
    stopHistoryPolling();
    S.id = null; S.album = null; S.rows = new Map(); S.genre = null;
    resetAccent();
    document.title = 'History, BOSS-ARMY Downloader';
    showScreen('history');
    window.scrollTo(0, 0);
    S.histActiveCount = 0;
    await Promise.all([loadHistory(), loadActive()]);
    scheduleHistoryPoll();
  }

  function scheduleHistoryPoll() {
    stopHistoryPolling();
    S.histTimer = setTimeout(async () => {
      if (els.history.hidden) return;
      const before = S.histActiveCount;
      await loadActive();
      if (S.histActiveCount < before) await loadHistory();    // something just finished
      scheduleHistoryPoll();
    }, 2000);
  }

  async function loadActive() {
    let result;
    try { result = await getJSON('/queue'); } catch (e) { return; }
    if (!result.ok || els.history.hidden) return;
    const jobs = (result.data.jobs || []).filter((j) => j.state === 'running' || j.state === 'queued');
    S.histActiveCount = jobs.length;
    els.histActive.hidden = jobs.length === 0;
    els.histActiveList.replaceChildren(...jobs.map((job) => {
      const li = el('li', 'hist-active-item');
      const text = el('div', 'h-text');
      text.append(el('div', 'h-title', job.title), el('div', 'h-sub', `${job.artist}, ${job.album}`));
      const state = el('div', 't-job');
      if (job.state === 'running') {
        const bar = el('span', 'pbar'); const fill = el('span', 'pfill');
        fill.style.width = Math.max(0, Math.min(100, job.percent || 0)) + '%';
        bar.append(fill);
        state.append(bar, el('span', 'pct', job.percent >= 99 ? 'Adding tags…' : `${job.percent || 0}%`));
      } else {
        state.append(icon('wait'), el('span', 't-job-text', 'Waiting in line'));
      }
      li.append(text, state);
      return li;
    }));
  }

  async function loadHistory() {
    let result;
    try { result = await getJSON('/history?limit=200'); } catch (e) { toast('Could not reach the downloader.', 'error'); return; }
    if (!result.ok) { toast(result.data.error || 'Could not load the history.', 'error'); return; }
    S.histRows = result.data.history || [];
    renderHistory();
  }

  function dayLabel(seconds) {
    const d = new Date(seconds * 1000);
    const today = new Date();
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return 'Today';
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (same(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function renderHistory() {
    const filter = S.histFilter;
    els.histFilters.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
    const rows = S.histRows.filter((r) =>
      filter === 'all' || (filter === 'saved' && r.state === 'done') || (filter === 'failed' && r.state === 'failed'));
    els.histList.replaceChildren();
    els.histEmpty.hidden = rows.length > 0;
    if (!rows.length) {
      els.histEmpty.textContent = S.histRows.length
        ? 'Nothing matches this filter.'
        : 'Nothing downloaded yet. Finished downloads show up here.';
      return;
    }
    let currentDay = '';
    let list = null;
    rows.forEach((r) => {
      const label = dayLabel(r.finished_at);
      if (label !== currentDay) {
        currentDay = label;
        els.histList.append(el('h3', 'hist-day', label));
        list = el('ul', 'hist-items');
        els.histList.append(list);
      }
      const li = el('li');
      const btn = el('button', 'hist-item');
      btn.type = 'button';
      const kind = r.state === 'done' ? 'saved' : r.state;
      const mark = el('span', 'h-mark is-' + kind);
      mark.append(icon(kind === 'saved' ? 'check' : kind === 'failed' ? 'cross' : 'dash'));
      const text = el('span', 'h-text');
      text.append(el('div', 'h-title', r.title), el('div', 'h-sub', `${r.artist}, ${r.album}`));
      if (r.state === 'failed') {
        text.append(el('div', 'h-msg', (r.message || 'Download failed').replace(/\s*Check the logs above\.?/, '')), el('div', 'h-hint', 'Open the album with this link filled in to try again'));
      } else if (r.state === 'cancelled') {
        text.append(el('div', 'h-hint', 'Cancelled'));
      }
      btn.append(mark, text, el('span', 'h-time', new Date(r.finished_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      btn.addEventListener('click', () => openFromHistory(r));
      li.append(btn);
      list.append(li);
    });
  }

  function openFromHistory(r) {
    S.pending = { id: r.release_id, key: `${r.disc}-${r.track}`, url: r.state === 'done' ? '' : r.url };
    history.pushState(null, '', '#' + r.release_id);
    loadAlbum(r.release_id);
  }

  function applyPending(id) {
    const p = S.pending;
    S.pending = null;
    if (!p || p.id !== id) return;
    const row = S.rows.get(p.key);
    if (!row) return;
    if (p.url && !row.have && !row.refs.url.value.trim()) {
      row.refs.url.value = p.url;
      row.url = p.url;
      checkLink(row);
    }
    row.el.scrollIntoView({ block: 'center' });
  }

  // ------------------------------------------------------------------ loading an album
  async function loadAlbum(id) {
    const token = ++S.loadToken;
    S.loadingId = id;
    if (!els.start.hidden) setStartMsg('Looking up the album…', 'busy');
    let result;
    try {
      result = await getJSON('/album?id=' + encodeURIComponent(id));
    } catch (e) {
      result = { data: { error: 'Could not reach the downloader. Is the service running?' } };
    }
    if (token !== S.loadToken) return;          // a newer request took over
    S.loadingId = null;
    if (result.data.error) {
      stopPolling();
      showScreen('start');
      setStartMsg(result.data.error, 'error');
      loadAlbumsList();
      return;
    }
    openAlbum(id, result.data);
  }

  function openAlbum(id, album) {
    stopPolling();
    S.id = id;
    S.album = album;
    buildRows(album);
    renderHero(id, album);
    renderTracks(album);
    if (location.hash.slice(1).toLowerCase() !== id) history.pushState(null, '', '#' + id);
    showScreen('album');
    window.scrollTo(0, 0);
    initGenre(id, album);
    restoreLinks().then(() => applyPending(id));
    updateSummary();
    updateBar();
    startPolling(0);                            // pick up downloads that kept running while the page was closed
  }

  function renderHero(id, album) {
    els.title.textContent = album.title;
    els.artist.textContent = album.artist;
    const trackCount = album.discs.reduce((n, d) => n + d.tracks.length, 0);
    els.facts.replaceChildren();
    const year = (album.date || '').slice(0, 4);
    if (year) els.facts.append(el('span', null, year));
    if (album.discs.length > 1) els.facts.append(el('span', null, `${album.discs.length} discs`));
    els.facts.append(el('span', null, `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`));

    document.title = `${album.title}, ${album.artist}`;
    els.coverWrap.classList.add('is-empty');
    els.heroBg.style.backgroundImage = '';
    els.cover.onload = () => {
      els.coverWrap.classList.remove('is-empty');
      els.heroBg.style.backgroundImage = `url("/cover?id=${id}")`;
      applyAccent(els.cover);
    };
    els.cover.onerror = () => {
      els.coverWrap.classList.add('is-empty');
      els.heroBg.style.backgroundImage = '';
      resetAccent();
    };
    els.cover.removeAttribute('src');
    els.cover.src = '/cover?id=' + id;
  }

  // ------------------------------------------------------------------ rows
  function buildRows(album) {
    S.rows = new Map();
    album.discs.forEach((d) => d.tracks.forEach((t) => {
      const row = {
        key: `${d.number}-${t.number}`, disc: d.number, track: t.number,
        title: t.title, length: t.length, have: !!t.have, fileGenres: t.genres || [],
        url: '', savedUrl: '', checkedUrl: '', info: null, job: null, checked: false,
        token: 0, timer: null, el: null, refs: {},
      };
      S.rows.set(row.key, row);
    }));
  }

  const TRACK_HTML = `
    <div class="t-main">
      <input class="t-check" type="checkbox" aria-label="Select this track">
      <span class="t-num"></span>
      <span class="t-title"></span>
      <span class="t-len"></span>
    </div>
    <div class="t-link">
      <input class="t-url" type="url" inputmode="url" placeholder="Paste a YouTube link" spellcheck="false" autocomplete="off" autocapitalize="off">
      <a class="icon-btn t-search" target="_blank" rel="noopener"></a>
      <button class="btn btn-ghost t-act" type="button">Download</button>
    </div>
    <div class="t-extra">
      <div class="t-info" hidden></div>
      <div class="t-job" hidden></div>
    </div>`;

  function makeRow(row, album) {
    const li = el('li', 'track');
    li.dataset.key = row.key;
    li.innerHTML = TRACK_HTML;                  // fixed template; track text is added below with textContent
    const r = row.refs = {
      check: $('.t-check', li), url: $('.t-url', li), act: $('.t-act', li), link: $('.t-link', li),
      info: $('.t-info', li), job: $('.t-job', li), search: $('.t-search', li),
    };
    $('.t-num', li).textContent = row.track;
    $('.t-title', li).textContent = row.title;
    $('.t-title', li).title = row.title;
    $('.t-len', li).textContent = fmtTime(row.length);
    r.check.setAttribute('aria-label', `Select ${row.title}`);
    r.url.setAttribute('aria-label', `YouTube link for ${row.title}`);
    r.search.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`${album.artist} ${row.title}`);
    r.search.title = 'Search YouTube for this track';
    r.search.setAttribute('aria-label', `Search YouTube for ${row.title}`);
    r.search.innerHTML = ICON.search;
    row.el = li;
    return li;
  }

  function renderTracks(album) {
    els.tracks.replaceChildren();
    album.discs.forEach((d) => {
      const section = el('section', 'disc');
      if (album.discs.length > 1) section.append(el('h3', 'disc-title', `Disc ${d.number}`));
      const list = el('ol', 'track-list');
      d.tracks.forEach((t) => list.append(makeRow(S.rows.get(`${d.number}-${t.number}`), album)));
      section.append(list);
      els.tracks.append(section);
    });
    S.rows.forEach(refresh);
  }

  // what a row can do right now
  const isActive = (row) => !!row.job && (row.job.state === 'queued' || row.job.state === 'running');
  const hasVerdict = (row) => !!row.info && ['ok', 'mismatch', 'nolen'].includes(row.info.status);
  const canDownload = (row) => !row.have && !isActive(row) && URL_RE.test(row.url) &&
    !!row.info && row.info.status !== 'bad';
  const isSelected = (row) => row.checked && hasVerdict(row) && !row.have && !isActive(row);

  function refresh(row) {
    const { refs } = row;
    const active = isActive(row);
    row.el.classList.toggle('is-have', row.have);
    row.el.classList.toggle('is-active', active);

    refs.check.disabled = row.have || active || !hasVerdict(row);
    refs.check.checked = isSelected(row);
    refs.link.hidden = row.have;
    refs.url.disabled = active;

    if (active) {
      refs.act.textContent = 'Cancel';
    } else {
      refs.act.textContent = row.job && row.job.state === 'failed' ? 'Retry' : 'Download';
    }
    refs.act.disabled = !active && !canDownload(row);

    renderInfo(row);
    renderJob(row);
  }

  function touch(row) { refresh(row); updateSummary(); updateBar(); }

  function renderInfo(row) {
    const box = row.refs.info;
    const info = row.info;
    if (row.have || !info) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    box.className = 't-info is-' + info.status;
    box.replaceChildren();

    if (info.status === 'finding') { box.append(spinner(), el('span', null, 'Searching YouTube…')); return; }
    if (info.status === 'checking') { box.append(spinner(), el('span', null, 'Checking the link…')); return; }
    if (info.status === 'bad') { box.append(icon('cross'), el('span', null, info.msg)); return; }

    if (info.thumbnail) {
      const img = el('img', 't-thumb');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      img.src = info.thumbnail;
      box.append(img);
    }
    const meta = el('div', 't-vmeta');
    const vt = el('div', 't-vtitle', info.title || 'Untitled video');
    vt.title = info.title || '';
    const verdict = el('div', 't-verdict');
    if (info.status === 'ok') {
      verdict.append(icon('check'), document.createTextNode(`Length matches (${fmtTime(info.duration)})`));
    } else if (info.status === 'mismatch') {
      verdict.append(icon('alert'), document.createTextNode(`Video is ${fmtTime(info.duration)}, album says ${fmtTime(row.length)}`));
    } else if (info.reason === 'video') {
      verdict.append(icon('dash'), document.createTextNode('This video has no length to compare'));
    } else {
      verdict.append(icon('dash'), document.createTextNode(`No album length to compare (video is ${fmtTime(info.duration)})`));
    }
    meta.append(vt, verdict);
    if (info.channel) {
      const src = el('div', 't-source');
      if (info.official) src.append(el('span', 't-badge', info.topic ? 'Topic' : 'Official'));
      const bits = [info.channel, fmtViews(info.views), info.abr ? `${info.abr} kbps` : ''].filter(Boolean);
      src.append(el('span', 't-sourcetext', bits.join(' · ')));
      meta.append(src);
    }
    if (info.alts && info.alts.length) {
      const more = el('button', 't-more', info.showAlts ? 'Hide other results' : `Other results (${info.alts.length})`);
      more.type = 'button';
      more.addEventListener('click', () => { info.showAlts = !info.showAlts; renderInfo(row); });
      meta.append(more);
    }
    box.append(meta);
    if (info.showAlts && info.alts) {
      const list = el('ul', 't-alts');
      info.alts.forEach((a) => {
        const li = el('li');
        const b = el('button', 't-alt');
        b.type = 'button';
        const diff = row.length != null && a.duration != null ? Math.abs(a.duration - row.length) : null;
        b.append(el('span', 't-alt-title', a.title),
          el('span', 't-alt-sub', [a.channel, fmtTime(a.duration), fmtViews(a.views), a.abr ? `${a.abr} kbps` : ''].filter(Boolean).join(' · ')));
        if (diff != null && diff > MATCH_SECONDS) b.classList.add('is-off');
        b.addEventListener('click', () => useCandidate(row, a, info.allCands));
        li.append(b);
        list.append(li);
      });
      box.append(list);
    }
  }

  function renderJob(row) {
    const box = row.refs.job;
    const job = row.job;

    if (row.have) {
      box.hidden = false;
      box.className = 't-job is-done';
      box.dataset.mode = 'have';
      box.replaceChildren(icon('check'), el('span', 't-job-text',
        job && job.state === 'done' ? 'Saved to your library' : 'In your library'));
      return;
    }
    if (!job) { box.hidden = true; box.dataset.mode = ''; box.replaceChildren(); return; }
    box.hidden = false;

    if (job.state === 'running') {
      let fill = $('.pfill', box);
      let label = $('.pct', box);
      if (box.dataset.mode !== 'running' || !fill) {
        box.className = 't-job is-running';
        box.dataset.mode = 'running';
        const bar = el('span', 'pbar');
        fill = el('span', 'pfill');
        bar.append(fill);
        label = el('span', 'pct');
        box.replaceChildren(bar, label);
      }
      const pct = Math.max(0, Math.min(100, job.percent || 0));
      fill.style.width = pct + '%';
      label.textContent = pct >= 99 ? 'Adding tags…' : `Downloading ${pct}%`;
      return;
    }

    box.dataset.mode = job.state;
    box.className = 't-job is-' + job.state;
    box.replaceChildren();
    if (job.state === 'queued') box.append(icon('wait'), el('span', 't-job-text', 'Waiting in line'));
    else if (job.state === 'failed') box.append(icon('cross'), el('span', 't-job-text', job.message || 'Download failed'));
    else if (job.state === 'cancelled') box.append(icon('dash'), el('span', 't-job-text', 'Cancelled'));
    else box.hidden = true;
  }

  function updateSummary() {
    const rows = [...S.rows.values()];
    const have = rows.filter((r) => r.have).length;
    const linked = rows.filter((r) => !r.have && URL_RE.test(r.url) && !(r.info && r.info.status === 'bad')).length;
    const need = rows.length - have - linked;
    if (have === rows.length) { els.summary.textContent = 'Every track is in your library.'; return; }
    const parts = [];
    if (have) parts.push(`${have} in your library`);
    if (linked) parts.push(`${linked} with a link`);
    if (need) parts.push(`${need} still need one`);
    els.summary.textContent = parts.join(', ');
  }

  function updateBar() {
    const rows = [...S.rows.values()];
    const selected = rows.filter(isSelected).length;
    const running = rows.filter((r) => r.job && r.job.state === 'running').length;
    const waiting = rows.filter((r) => r.job && r.job.state === 'queued').length;
    els.barCount.textContent = selected ? `${selected} selected` : 'Nothing selected';
    els.barGo.textContent = selected ? `Download selected (${selected})` : 'Download selected';
    els.barGo.disabled = selected === 0;
    const parts = [];
    if (running) parts.push(`downloading ${running}`);
    if (waiting) parts.push(`waiting ${waiting}`);
    els.barQueue.textContent = parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : '';
    els.barCancel.hidden = running + waiting === 0;
  }

  // ------------------------------------------------------------------ link checking
  // Pasted links are kept by the server (per album), so every device sees the same ones.
  let linkTimer = null;

  function saveLinks() {
    clearTimeout(linkTimer);
    linkTimer = setTimeout(flushLinks, 500);
  }

  async function flushLinks() {
    if (!S.id) return;
    const id = S.id;
    const changes = [...S.rows.values()].filter((r) => !r.have && r.url !== r.savedUrl);
    if (!changes.length) return;
    const sent = changes.map((r) => ({ row: r, url: r.url }));
    try {
      const result = await getJSON('/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ release: id, links: sent.map((s) => ({ disc: s.row.disc, track: s.row.track, url: s.url })) }),
      });
      if (result.ok) sent.forEach((s) => { s.row.savedUrl = s.url; });
    } catch (e) { /* the next change tries again */ }
  }

  async function restoreLinks() {
    const id = S.id;
    let links = {};
    try {
      const result = await getJSON('/links?release=' + encodeURIComponent(id));
      if (result.ok) links = result.data.links || {};
    } catch (e) { /* no saved links to show */ }
    if (id !== S.id) return;

    // Links that older versions of this page kept in the browser: move them to the server once.
    const legacyKey = 'ba_links_' + id;
    const legacy = store.get(legacyKey, {});
    const merged = {};
    Object.keys(legacy).forEach((key) => { if (S.rows.has(key) && URL_RE.test(legacy[key])) merged[key] = legacy[key]; });
    Object.assign(merged, links);                         // what the server has wins
    const needsSync = Object.keys(merged).some((key) => merged[key] !== links[key]);

    Object.keys(merged).forEach((key) => {
      const row = S.rows.get(key);
      if (!row || row.have || row.refs.url.value.trim()) return;
      row.refs.url.value = merged[key];
      row.url = merged[key];
      row.savedUrl = links[key] || '';
      checkLink(row);
    });
    if (needsSync) {
      flushLinks().then(() => { try { localStorage.removeItem(legacyKey); } catch (e) { /* ignore */ } });
    }
  }

  async function checkLink(row) {
    clearTimeout(row.timer);
    const url = row.refs.url.value.trim();
    row.url = url;

    if (!url) {
      row.info = null; row.checkedUrl = ''; row.checked = false;
      touch(row); saveLinks();
      return;
    }
    if (url === row.checkedUrl && row.info) return;      // already checked this exact link
    row.checkedUrl = url;
    saveLinks();

    if (!URL_RE.test(url)) {
      row.info = { status: 'bad', msg: 'Paste a full link that starts with https://' };
      row.checked = false;
      touch(row);
      return;
    }

    const token = ++row.token;
    row.info = { status: 'checking' };
    row.checked = false;
    touch(row);

    let result;
    try {
      result = await getJSON('/linkinfo?url=' + encodeURIComponent(url));
    } catch (e) {
      result = { ok: false, data: { error: 'Could not reach the downloader.' } };
    }
    if (token !== row.token || S.rows.get(row.key) !== row) return;   // a newer paste or album replaced this one

    if (!result.ok || result.data.error) {
      row.info = { status: 'bad', msg: result.data.error || 'Could not check that link.' };
      row.checkedUrl = '';                                // let the same link be tried again
      row.checked = false;
      touch(row);
      return;
    }

    const info = { title: result.data.title, duration: result.data.duration, thumbnail: result.data.thumbnail };
    setVerdict(row, info);

    row.info = info;
    row.checked = info.status === 'ok' && !row.have && !isActive(row);    // only a clean match ticks itself
    touch(row);
  }

  function setVerdict(row, info) {
    if (info.duration == null) { info.status = 'nolen'; info.reason = 'video'; }
    else if (row.length == null) { info.status = 'nolen'; info.reason = 'album'; }
    else if (Math.abs(info.duration - row.length) <= MATCH_SECONDS) info.status = 'ok';
    else info.status = 'mismatch';
    return info;
  }

  function fmtViews(n) {
    if (!n) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B views';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M views';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K views';
    return n + ' views';
  }

  // ------------------------------------------------------------------ finding links
  function useCandidate(row, cand, alts) {
    row.url = cand.url;
    row.refs.url.value = cand.url;
    row.checkedUrl = cand.url;
    const info = setVerdict(row, {
      title: cand.title, duration: cand.duration, thumbnail: cand.thumbnail,
      channel: cand.channel, views: cand.views, official: cand.official, topic: cand.topic, abr: cand.abr,
      alts: alts.filter((a) => a.url !== cand.url), allCands: alts, showAlts: false,
    });
    row.info = info;
    row.checked = info.status === 'ok' && !row.have && !isActive(row);
    saveLinks();
    touch(row);
  }

  let finding = false;

  async function findLinks() {
    if (finding || !S.id) return;
    const id = S.id;
    const todo = [...S.rows.values()].filter((r) => !r.have && !isActive(r) && !r.refs.url.value.trim());
    if (!todo.length) { toast('Every track already has a link or is saved.'); return; }
    finding = true;
    els.findBtn.disabled = true;
    todo.forEach((r) => { r.info = { status: 'finding' }; r.checked = false; touch(r); });

    let done = 0;
    let found = 0;
    const label = () => { els.findLabel.textContent = `Finding ${done} of ${todo.length}`; };
    label();
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        if (S.id !== id || S.rows.get(row.key) !== row) return;
        let result;
        try {
          result = await getJSON(`/findlinks?release=${encodeURIComponent(id)}&disc=${row.disc}&track=${row.track}`);
        } catch (e) { result = { ok: false, data: { error: 'Could not reach the downloader.' } }; }
        if (S.id !== id || S.rows.get(row.key) !== row) return;
        done += 1;
        label();
        if (row.refs.url.value.trim()) continue;               // you pasted one while it searched
        const list = (result.ok && result.data.results) || [];
        if (!list.length) {
          row.info = { status: 'bad', msg: result.ok ? 'No video found. Paste a link or search YouTube.' : (result.data.error || 'Search failed.') };
          touch(row);
          continue;
        }
        useCandidate(row, list[0], list);
        if (row.info.status === 'ok') found += 1;
      }
    };
    await Promise.all([worker(), worker()]);
    finding = false;
    els.findBtn.disabled = false;
    els.findLabel.textContent = 'Find links';
    if (S.id === id) {
      const review = todo.length - found;
      toast(review ? `Found ${found} of ${todo.length}. ${review} need a look.` : `Found all ${todo.length}.`);
    }
  }

  function focusNext(row) {
    const rows = [...S.rows.values()];
    const after = rows.slice(rows.indexOf(row) + 1).filter((r) => !r.have && !isActive(r));
    const next = after.find((r) => !r.refs.url.value.trim()) || after[0];
    if (!next) return;
    next.el.scrollIntoView({ block: 'center' });
    next.refs.url.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ downloading
  async function enqueue(rows) {
    rows = rows.filter(canDownload);
    if (!rows.length) return;
    await flushGenre();                           // the server tags each file with the chosen genres
    let result;
    try {
      result = await getJSON('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          release: S.id,
          tracks: rows.map((r) => ({ disc: r.disc, track: r.track, url: r.url })),
        }),
      });
    } catch (e) {
      toast('Could not reach the downloader.', 'error');
      return;
    }
    if (!result.ok) { toast(result.data.error || 'The downloader refused that.', 'error'); return; }

    let queued = 0;
    (result.data.results || []).forEach((res) => {
      const row = S.rows.get(`${res.disc}-${res.track}`);
      if (!row) return;
      if (res.status === 'queued') {
        row.job = { id: res.id, state: 'queued', percent: 0, message: 'Waiting...' };
        row.checked = false;
        queued += 1;
      } else if (res.status === 'skipped') {
        row.have = true; row.checked = false;
      } else if (res.status === 'rejected') {
        toast(`Track ${row.track}: ${res.message}`, 'error');
      }
      touch(row);
    });
    if (queued) {
      toast(`Queued ${queued} ${queued === 1 ? 'track' : 'tracks'}`);
      startPolling(300);
    }
  }

  async function cancelJobs(row) {
    // Cancel one row's job, or every active job of this album when no row is given.
    const url = row ? '/queue/cancel?id=' + encodeURIComponent(row.job.id)
                     : '/queue/cancel?release=' + encodeURIComponent(S.id);
    try { await getJSON(url, { method: 'POST' }); }
    catch (e) { toast('Could not reach the downloader.', 'error'); return; }
    startPolling(200);
  }

  const hasActive = () => [...S.rows.values()].some(isActive);

  function startPolling(delay) {
    if (S.pollTimer) clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(poll, delay);
  }

  function stopPolling() {
    if (S.pollTimer) clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }

  async function poll() {
    S.pollTimer = null;
    const id = S.id;
    if (!id) return;
    let result = null;
    try { result = await getJSON('/queue?release=' + encodeURIComponent(id)); }
    catch (e) { result = null; }
    if (id !== S.id) return;
    if (result && result.ok) applyJobs(result.data.jobs || []);
    if (hasActive()) S.pollTimer = setTimeout(poll, result && result.ok ? POLL_MS : POLL_MS * 2.5);
  }

  function applyJobs(jobs) {
    const seen = new Set();
    jobs.forEach((job) => {                              // oldest first, so the newest try for a track wins
      const row = S.rows.get(`${job.disc}-${job.track}`);
      if (!row) return;
      row.job = job;
      seen.add(row.key);
    });
    let newlySaved = false;
    S.rows.forEach((row) => {
      if (isActive(row) && !seen.has(row.key)) {
        row.job = { state: 'failed', message: 'Lost track of this download. The service may have restarted.' };
      }
      if (row.job && (row.job.state === 'done' || row.job.state === 'skipped')) {
        if (!row.have) newlySaved = true;
        row.have = true; row.checked = false;
      }
      touch(row);
    });
    if (newlySaved) refreshFileGenres();
    saveLinks();
  }

  // ------------------------------------------------------------------ genre
  const sameGenres = (a, b) => {
    const key = (list) => list.map((g) => g.toLowerCase()).sort().join('|');
    return key(a) === key(b);
  };

  function initGenre(id, album) {
    const g = S.genre = {
      id, suggestions: [], extras: [], loading: true, ready: null, saveTimer: null,
      chosen: Array.isArray(album.saved_genres) ? album.saved_genres.slice() : null,
    };
    g.savedJson = g.chosen === null ? null : JSON.stringify(g.chosen);
    els.genreList.replaceChildren(...COMMON_GENRES.map((name) => { const o = document.createElement('option'); o.value = name; return o; }));
    els.genreInput.value = '';
    renderGenre();
    g.ready = (async () => {
      try {
        const result = await getJSON('/genre/suggest?id=' + encodeURIComponent(id));
        if (result.ok && Array.isArray(result.data.suggestions)) g.suggestions = result.data.suggestions;
      } catch (e) { /* no suggestions; the quick picks still work */ }
      if (S.genre !== g) return;
      g.loading = false;
      if (g.chosen === null && g.suggestions.length) {       // first time: start with the best two, so you only adjust
        g.chosen = g.suggestions.slice(0, 2);
        queueGenreSave();
      }
      renderGenre();
    })();
  }

  function genreCandidates(g) {
    const list = [];
    const add = (name) => { if (name && !list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name); };
    g.suggestions.forEach(add);
    (g.chosen || []).forEach(add);
    g.extras.forEach(add);
    if (g.suggestions.length < 4) QUICK_GENRES.forEach((name) => { if (list.length < 8) add(name); });
    return list;
  }

  function renderGenre() {
    const g = S.genre;
    if (!g) return;
    const chosen = g.chosen || [];
    els.genreChips.replaceChildren(...genreCandidates(g).map((name) => {
      const btn = el('button', 'genre-pick', name);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', chosen.some((x) => x.toLowerCase() === name.toLowerCase()) ? 'true' : 'false');
      btn.addEventListener('click', () => toggleGenre(name));
      return btn;
    }));

    els.genreHint.replaceChildren();
    if (g.loading) els.genreHint.append(spinner(), document.createTextNode('Looking up genres…'));
    else if (!g.suggestions.length && !chosen.length) els.genreHint.textContent = 'MusicBrainz has no genre for this album. Pick one.';
    else if (!chosen.length) els.genreHint.textContent = 'No genre will be written. Tap one to add it.';
    else els.genreHint.textContent = 'Written into every track. Tap to change.';

    // Files already in the library that carry a different genre than the one chosen now
    const need = g.chosen === null ? [] : [...S.rows.values()].filter((r) => r.have && !sameGenres(r.fileGenres, g.chosen));
    els.genreApply.hidden = need.length === 0;
    if (need.length) {
      els.genreApplyText.textContent = `${need.length} saved ${need.length === 1 ? 'track has' : 'tracks have'} a different genre.`;
    }
  }

  function toggleGenre(name) {
    const g = S.genre;
    const chosen = g.chosen || [];
    const at = chosen.findIndex((x) => x.toLowerCase() === name.toLowerCase());
    g.chosen = at >= 0 ? chosen.filter((_, i) => i !== at) : chosen.concat(name);
    if (g.chosen.length > 8) g.chosen = g.chosen.slice(0, 8);
    renderGenre();
    queueGenreSave();
  }

  function addGenreFromInput() {
    const g = S.genre;
    const name = els.genreInput.value.trim();
    if (!g || !name) return;
    els.genreInput.value = '';
    const known = genreCandidates(g).find((x) => x.toLowerCase() === name.toLowerCase());
    if (!known) g.extras.push(name);
    if (!(g.chosen || []).some((x) => x.toLowerCase() === name.toLowerCase())) toggleGenre(known || name);
    else renderGenre();
  }

  function queueGenreSave() {
    const g = S.genre;
    clearTimeout(g.saveTimer);
    g.saveTimer = setTimeout(flushGenre, 400);
  }

  async function flushGenre() {
    const g = S.genre;
    if (!g) return;
    if (g.ready) await g.ready;                          // wait for the suggestions, so the first choice is not lost
    clearTimeout(g.saveTimer);
    g.saveTimer = null;
    if (g.chosen === null || g.savedJson === JSON.stringify(g.chosen)) return;
    const body = JSON.stringify({ release: g.id, genres: g.chosen });
    try {
      const result = await getJSON('/genre/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (result.ok) g.savedJson = JSON.stringify(g.chosen);
      else toast(result.data.error || 'Could not save the genre.', 'error');
    } catch (e) { toast('Could not reach the downloader to save the genre.', 'error'); }
  }

  async function refreshFileGenres() {
    const id = S.id;
    if (!id) return;
    let result;
    try { result = await getJSON('/album?refresh=1&id=' + encodeURIComponent(id)); } catch (e) { return; }
    if (id !== S.id || !result.ok || result.data.error) return;
    result.data.discs.forEach((d) => d.tracks.forEach((t) => {
      const row = S.rows.get(`${d.number}-${t.number}`);
      if (row) row.fileGenres = t.genres || [];
    }));
    renderGenre();
  }

  async function applyGenre() {
    await flushGenre();
    els.genreApplyBtn.disabled = true;
    try {
      const result = await getJSON('/genre/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ release: S.id }),
      });
      if (!result.ok) toast(result.data.error || 'Could not update the saved tracks.', 'error');
      else {
        const n = result.data.updated;
        toast(n ? `Updated ${n} ${n === 1 ? 'track' : 'tracks'}` : 'Saved tracks already match.');
        if (result.data.failed) toast(`${result.data.failed} tracks could not be changed.`, 'error');
      }
    } catch (e) { toast('Could not reach the downloader.', 'error'); }
    els.genreApplyBtn.disabled = false;
    refreshFileGenres();
  }

  // ------------------------------------------------------------------ wiring
  els.releaseInput.addEventListener('input', onStartInput);
  els.releaseInput.addEventListener('paste', () => setTimeout(onStartInput, 0));
  els.change.addEventListener('click', () => { history.pushState(null, '', location.pathname); showStart(); });

  const rowOf = (target) => {
    const li = target.closest('li.track');
    return li ? S.rows.get(li.dataset.key) : null;
  };

  els.tracks.addEventListener('input', (e) => {
    if (!e.target.classList.contains('t-url')) return;
    const row = rowOf(e.target);
    if (!row) return;
    row.url = e.target.value.trim();
    clearTimeout(row.timer);
    row.timer = setTimeout(() => checkLink(row), 400);
    if (!row.url) checkLink(row);
  });

  els.tracks.addEventListener('paste', (e) => {
    if (!e.target.classList.contains('t-url')) return;
    const row = rowOf(e.target);
    if (!row) return;
    setTimeout(() => {                                   // after the pasted text has landed
      checkLink(row);
      if (URL_RE.test(e.target.value.trim())) focusNext(row);
    }, 0);
  });

  els.tracks.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList.contains('t-url')) return;
    const row = rowOf(e.target);
    if (!row) return;
    checkLink(row);
    if (URL_RE.test(e.target.value.trim())) focusNext(row);
  });

  els.tracks.addEventListener('change', (e) => {
    if (!e.target.classList.contains('t-check')) return;
    const row = rowOf(e.target);
    if (!row) return;
    row.checked = e.target.checked;
    touch(row);
  });

  els.tracks.addEventListener('click', (e) => {
    const btn = e.target.closest('.t-act');
    if (!btn) return;
    const row = rowOf(btn);
    if (!row) return;
    if (isActive(row)) cancelJobs(row); else enqueue([row]);
  });

  els.genreAdd.addEventListener('click', addGenreFromInput);
  els.findBtn.addEventListener('click', findLinks);
  els.albumsToggle.addEventListener('click', () => setAlbumsOpen(els.albumsBody.hidden));
  els.albumsSearch.addEventListener('input', renderAlbums);
  els.albumsBody.hidden = !store.get('ba_albums_open', false);
  els.albumsToggle.setAttribute('aria-expanded', els.albumsBody.hidden ? 'false' : 'true');
  els.genreInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addGenreFromInput(); } });
  els.genreInput.addEventListener('change', addGenreFromInput);     // picking from the suggestion list
  els.genreApplyBtn.addEventListener('click', applyGenre);

  els.histFilters.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    S.histFilter = b.dataset.filter;
    renderHistory();
  });

  els.barGo.addEventListener('click', () => enqueue([...S.rows.values()].filter(isSelected)));
  els.barCancel.addEventListener('click', () => cancelJobs(null));

  function route() {
    if (location.hash === '#history') { showHistory(); return; }
    const id = (location.hash.match(UUID_RE) || [''])[0].toLowerCase();
    if (id && id !== S.id) loadAlbum(id);
    else if (!id) showStart();
  }

  window.addEventListener('popstate', route);
  route();
})();
