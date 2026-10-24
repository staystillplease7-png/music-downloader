import json
import os
import queue
import re
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from flask import Flask, request, Response, render_template, jsonify
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TPE2, TALB, TDRC, TRCK, TPOS, TCON, APIC

app = Flask(__name__)

# Settings. Change them with environment variables, no need to edit this file.
#   MUSIC_DIR   where finished albums go             (default /srv/media/music)
#   PLAYER_URL  link for the "Open player" button    (default: no button)
#   DB_PATH     the small SQLite file                (default boss-army.db next to app.py)
#   MB_CONTACT  contact MusicBrainz can reach you on (default: this project's GitHub page)
#   HOST, PORT  where the web page listens           (default 0.0.0.0 and 8083)
MUSIC_BASE = os.environ.get('MUSIC_DIR', '/srv/media/music')
MYMPD_URL = os.environ.get('PLAYER_URL', '')
DB_PATH = os.environ.get('DB_PATH') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'boss-army.db')

MB_CONTACT = os.environ.get('MB_CONTACT', 'https://github.com/staystillplease7-png/music-downloader')
MB_USER_AGENT = f"MusicDownloader/1.0 ({MB_CONTACT})"
MB_BASE = "https://musicbrainz.org/ws/2"
MB_RELEASE_URL = MB_BASE + "/release/{}?inc=recordings+artist-credits+genres+release-groups&fmt=json"
MB_GROUP_URL = MB_BASE + "/release-group/{}?inc=genres&fmt=json"
MB_ARTIST_URL = MB_BASE + "/artist/{}?inc=genres&fmt=json"
MB_MIN_GAP = 1.0              # MusicBrainz asks for at most one request per second
CAA_FRONT_URL = "https://coverartarchive.org/release/{}/front-500"
UUID_RE = re.compile(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
)
URL_RE = re.compile(r'^https?://\S+$')

ALBUM_CACHE = {}
COVER_CACHE = {}
GENRE_CACHE = {}
LINKINFO_CACHE = {}
CACHE_SECONDS = 600
LINKINFO_SLOTS = threading.Semaphore(3)   # at most 3 YouTube lookups at once

# Running yt-dlp process groups by job id, so a cancel can stop them
active_downloads = {}


# ---------------------------------------------------------------- database
# One small SQLite file next to app.py. It remembers: pasted links, the download queue,
# download history and the genre chosen for each album.

SCHEMA = """
CREATE TABLE IF NOT EXISTS links (
    release_id TEXT NOT NULL, disc INTEGER NOT NULL, track INTEGER NOT NULL,
    url TEXT NOT NULL, updated REAL,
    PRIMARY KEY (release_id, disc, track)
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, release_id TEXT, disc INTEGER, track INTEGER,
    title TEXT, url TEXT, artist TEXT, album TEXT,
    state TEXT, percent INTEGER, message TEXT, filename TEXT,
    created REAL, finished_at REAL
);
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, finished_at REAL,
    release_id TEXT, disc INTEGER, track INTEGER,
    artist TEXT, album TEXT, title TEXT, url TEXT,
    state TEXT, filename TEXT, message TEXT
);
CREATE TABLE IF NOT EXISTS albums (
    release_id TEXT PRIMARY KEY, title TEXT, artist TEXT,
    genres TEXT, updated REAL
);
CREATE TABLE IF NOT EXISTS opened_albums (
    release_id TEXT PRIMARY KEY, title TEXT, artist TEXT, date TEXT,
    track_count INTEGER, have_count INTEGER,
    first_opened REAL, last_opened REAL, open_count INTEGER
);
"""

_db_ready = set()
_db_lock = threading.Lock()


@contextmanager
def db():
    """Open the database (creating the tables the first time), commit on success."""
    with _db_lock:
        if DB_PATH not in _db_ready:
            setup = sqlite3.connect(DB_PATH, timeout=10)
            try:
                setup.execute('PRAGMA journal_mode=WAL')
                setup.executescript(SCHEMA)
                setup.commit()
            finally:
                setup.close()
            _db_ready.add(DB_PATH)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def db_quiet(func, *args):
    """Run a database write; a database problem is printed to the log but never stops a download."""
    try:
        return func(*args)
    except Exception as e:
        print(f'database problem in {func.__name__}: {e}', flush=True)
        return None


def get_links(release_id):
    with db() as conn:
        rows = conn.execute('SELECT disc, track, url FROM links WHERE release_id = ?', (release_id,)).fetchall()
    return {f"{r['disc']}-{r['track']}": r['url'] for r in rows}


def set_link(release_id, disc, track, url):
    with db() as conn:
        if url:
            conn.execute(
                'INSERT INTO links (release_id, disc, track, url, updated) VALUES (?, ?, ?, ?, ?) '
                'ON CONFLICT(release_id, disc, track) DO UPDATE SET url = excluded.url, updated = excluded.updated',
                (release_id, disc, track, url, time.time()))
        else:
            conn.execute('DELETE FROM links WHERE release_id = ? AND disc = ? AND track = ?',
                         (release_id, disc, track))


def get_saved_genres(release_id):
    """The genres chosen for this album: a list, or None if nothing was ever chosen."""
    with db() as conn:
        row = conn.execute('SELECT genres FROM albums WHERE release_id = ?', (release_id,)).fetchone()
    if not row or row['genres'] is None:
        return None
    try:
        value = json.loads(row['genres'])
    except ValueError:
        return None
    return value if isinstance(value, list) else None


def save_genres(release_id, album_data, genres):
    with db() as conn:
        conn.execute(
            'INSERT INTO albums (release_id, title, artist, genres, updated) VALUES (?, ?, ?, ?, ?) '
            'ON CONFLICT(release_id) DO UPDATE SET title = excluded.title, artist = excluded.artist, '
            'genres = excluded.genres, updated = excluded.updated',
            (release_id, album_data['title'], album_data['artist'], json.dumps(genres), time.time()))


def db_record_open(release_id, album_data, have_count, count_open=True):
    """Remember that this album was looked up (so it can be found again), and how many of its
    tracks are in the library. With count_open=False it only refreshes the numbers of an
    album that is already remembered."""
    track_count = sum(len(d['tracks']) for d in album_data['discs'])
    now = time.time()
    with db() as conn:
        if count_open:
            conn.execute(
                'INSERT INTO opened_albums (release_id, title, artist, date, track_count, have_count, '
                'first_opened, last_opened, open_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) '
                'ON CONFLICT(release_id) DO UPDATE SET title = excluded.title, artist = excluded.artist, '
                'date = excluded.date, track_count = excluded.track_count, have_count = excluded.have_count, '
                'last_opened = excluded.last_opened, open_count = open_count + 1',
                (release_id, album_data['title'], album_data['artist'], album_data['date'],
                 track_count, have_count, now, now))
        else:
            conn.execute('UPDATE opened_albums SET track_count = ?, have_count = ? WHERE release_id = ?',
                         (track_count, have_count, release_id))


def db_bump_have(release_id):
    with db() as conn:
        conn.execute('UPDATE opened_albums SET have_count = MIN(track_count, have_count + 1) '
                     'WHERE release_id = ?', (release_id,))


def db_save_job(job):
    with db() as conn:
        conn.execute(
            'INSERT INTO jobs (id, release_id, disc, track, title, url, artist, album, state, percent, '
            'message, filename, created, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
            'ON CONFLICT(id) DO UPDATE SET state = excluded.state, percent = excluded.percent, '
            'message = excluded.message, filename = excluded.filename, finished_at = excluded.finished_at',
            (job['id'], job['release'], job['disc'], job['track'], job['title'], job['url'],
             job['artist'], job['album'], job['state'], job['percent'], job['message'],
             job['filename'], job['created'], job['finished_at']))


def db_delete_job(job_id):
    with db() as conn:
        conn.execute('DELETE FROM jobs WHERE id = ?', (job_id,))


def db_add_history(job):
    with db() as conn:
        conn.execute(
            'INSERT INTO history (finished_at, release_id, disc, track, artist, album, title, url, '
            'state, filename, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (job['finished_at'], job['release'], job['disc'], job['track'], job['artist'],
             job['album'], job['title'], job['url'], job['state'], job['filename'], job['message']))


# ---------------------------------------------------------------- tags
def apply_album_tags(filepath, album, disc_number, track_number, cover, genres=None):
    """Write one track's tags from the album data (what /album returns) into an MP3.
    cover is the image bytes, or None for no picture. genres is a list of names."""
    disc = next((d for d in album['discs'] if d['number'] == disc_number), None)
    if disc is None:
        raise ValueError(f"Disc {disc_number} not found in this album")
    track = next((t for t in disc['tracks'] if t['number'] == track_number), None)
    if track is None:
        raise ValueError(f"Track {track_number} not found on disc {disc_number}")

    try:
        tags = ID3(filepath)
    except ID3NoHeaderError:
        tags = ID3()

    def put(frame_class, text):
        if text:
            tags.setall(frame_class.__name__, [frame_class(encoding=3, text=text)])

    put(TIT2, track['title'])
    put(TPE1, album['artist'])
    put(TPE2, album['artist'])
    put(TALB, album['title'])
    put(TDRC, album['date'])
    put(TRCK, f"{track_number}/{len(disc['tracks'])}")
    put(TPOS, f"{disc_number}/{len(album['discs'])}")
    if genres:
        tags.setall('TCON', [TCON(encoding=3, text=list(genres))])

    tags.delall('APIC')
    if cover:
        mime = 'image/png' if cover.startswith(b'\x89PNG') else 'image/jpeg'
        tags.add(APIC(encoding=3, mime=mime, type=3, desc='Cover', data=cover))

    tags.save(filepath)


def read_file_genres(filepath):
    """The genre names already written in a file ([] if none or unreadable)."""
    try:
        frame = ID3(filepath).get('TCON')
        return [str(g) for g in frame.genres] if frame else []
    except Exception:
        return []


def write_file_genres(filepath, genres):
    """Change only the genre tag of a file, leaving every other tag alone."""
    try:
        tags = ID3(filepath)
    except ID3NoHeaderError:
        tags = ID3()
    if genres:
        tags.setall('TCON', [TCON(encoding=3, text=list(genres))])
    else:
        tags.delall('TCON')
    tags.save(filepath)


def same_genres(a, b):
    return sorted(g.lower() for g in a) == sorted(g.lower() for g in b)


def clean_genres(value):
    """Check a genre list sent by the page. Returns a clean list, or None if it is not a list."""
    if not isinstance(value, list):
        return None
    out = []
    for item in value:
        if not isinstance(item, str):
            continue
        name = re.sub(r'[\x00-\x1f]', '', item).strip()
        if 0 < len(name) <= 40 and name.lower() not in [g.lower() for g in out]:
            out.append(name)
    return out[:8]


# ---------------------------------------------------------------- MusicBrainz
class MusicBrainzError(Exception):
    """A problem talking to MusicBrainz, with a message that is safe to show."""


_mb_lock = threading.Lock()
_mb_last = [0.0]


def mb_get(url):
    """GET one MusicBrainz JSON page, never faster than one request per second."""
    with _mb_lock:
        wait = MB_MIN_GAP - (time.time() - _mb_last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': MB_USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.load(resp)
        finally:
            _mb_last[0] = time.time()


def genre_list(items):
    """MusicBrainz genre entries -> [(name, votes)], most voted first."""
    out = []
    for g in items or []:
        if isinstance(g, dict) and g.get('name'):
            out.append((str(g['name']), int(g.get('count') or 0)))
    return sorted(out, key=lambda x: -x[1])


def parse_release(data):
    """Turn MusicBrainz's big release JSON into the small shape we need."""
    credits = data.get('artist-credit', [])
    artist = ''.join(c.get('name', '') + c.get('joinphrase', '') for c in credits)
    artist_ids = [c['artist']['id'] for c in credits
                  if isinstance(c.get('artist'), dict) and c['artist'].get('id')]

    discs = []
    for index, medium in enumerate(data.get('media', []), start=1):
        tracks = []
        for t in medium.get('tracks', []):
            ms = t.get('length')
            tracks.append({
                'number': t.get('position'),
                'title': t.get('title', ''),
                'length': round(ms / 1000) if ms else None,
            })
        discs.append({'number': medium.get('position', index), 'tracks': tracks})

    group = data.get('release-group')
    return {
        'title': data.get('title', ''),
        'artist': artist,
        'date': data.get('date', ''),
        'discs': discs,
        'group_id': group.get('id', '') if isinstance(group, dict) else '',
        'artist_ids': artist_ids,
        'release_genres': genre_list(data.get('genres')),
    }


def fetch_album(release_id):
    """Return the album data for a release ID. Raises MusicBrainzError."""
    cached = ALBUM_CACHE.get(release_id)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    try:
        data = mb_get(MB_RELEASE_URL.format(release_id))
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):
            raise MusicBrainzError('Album not found. Check the ID.')
        if e.code == 503:
            raise MusicBrainzError('MusicBrainz is busy. Wait a few seconds and try again.')
        raise MusicBrainzError(f'MusicBrainz returned error {e.code}.')
    except Exception as e:
        raise MusicBrainzError(f'Could not reach MusicBrainz: {e}')

    album_data = parse_release(data)
    ALBUM_CACHE[release_id] = (time.time(), album_data)
    return album_data


SMALL_WORDS = {'and', 'of', 'the'}
GENRE_FIXES = {'r&b': 'R&B', 'edm': 'EDM', 'ost': 'OST', 'dj': 'DJ'}


def pretty_genre(name):
    low = name.strip().lower()
    if low in GENRE_FIXES:
        return GENRE_FIXES[low]
    words = []
    for i, word in enumerate(low.split(' ')):
        if i and word in SMALL_WORDS:
            words.append(word)
        else:
            words.append('-'.join(p.capitalize() for p in word.split('-')))
    return ' '.join(words)


def genre_suggestions(release_id):
    """Genre names MusicBrainz knows for this album, best first.
    Looks at the album's group (counts most), the release, then the artist."""
    cached = GENRE_CACHE.get(release_id)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    album_data = fetch_album(release_id)

    scores = {}

    def add(items, weight):
        if not items:
            return
        top = max(c for _, c in items) or 1
        for name, count in items:
            key = name.lower()
            scores[key] = scores.get(key, 0) + weight * ((count or 1) / top)

    add(album_data['release_genres'], 2)
    if album_data['group_id']:
        try:
            add(genre_list(mb_get(MB_GROUP_URL.format(album_data['group_id'])).get('genres')), 3)
        except Exception as e:
            print(f'genre lookup (album group) failed: {e}', flush=True)
    for artist_id in album_data['artist_ids'][:2]:
        try:
            add(genre_list(mb_get(MB_ARTIST_URL.format(artist_id)).get('genres')), 1)
        except Exception as e:
            print(f'genre lookup (artist) failed: {e}', flush=True)

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    names = [pretty_genre(k) for k, _ in ranked][:8]
    GENRE_CACHE[release_id] = (time.time(), names)
    return names


# ---------------------------------------------------------------- covers and file names
def fetch_cover(release_id):
    """Return (image_bytes, content_type), or None if the album has no cover."""
    req = urllib.request.Request(
        CAA_FRONT_URL.format(release_id),
        headers={'User-Agent': MB_USER_AGENT}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get_content_type()
            if not content_type.startswith('image/'):
                content_type = 'image/jpeg'
            return resp.read(), content_type
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):
            return None
        raise


def get_cover_bytes(release_id):
    """Cover image bytes for a release, or None if it has no cover. Cached for 10 minutes."""
    cached = COVER_CACHE.get(release_id)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    result = fetch_cover(release_id)
    data = result[0] if result else None
    COVER_CACHE[release_id] = (time.time(), data)
    return data


def sanitize_filename(name):
    """Strip characters that are illegal/problematic in filenames."""
    name = re.sub(r'[\\/:*?"<>|]', '', name)
    return name.strip()


def safe_name(name):
    """Make text safe to use as one folder or file name."""
    name = re.sub(r'[\x00-\x1f]', '', sanitize_filename(name or ''))
    name = name[:150].strip('. ')
    return name or 'Unknown'


def track_paths(album_data, disc_number, track_number, title):
    """Folder and full file path for one track: Artist/Album/03 - Title.mp3
    (or 2-03 - Title.mp3 when the album has more than one disc)."""
    album_dir = os.path.join(
        MUSIC_BASE, safe_name(album_data['artist']), safe_name(album_data['title'])
    )
    if len(album_data['discs']) > 1:
        prefix = f"{disc_number}-{track_number:02d}"
    else:
        prefix = f"{track_number:02d}"
    return album_dir, os.path.join(album_dir, f"{prefix} - {safe_name(title)}.mp3")


def album_for_page(release_id, album_data):
    """The album as the page wants it: every track says whether the file is already in the
    library and which genres it carries, plus the genres chosen for the album (or None)."""
    out = dict(album_data)
    out['discs'] = []
    for d in album_data['discs']:
        tracks = []
        for t in d['tracks']:
            _, path = track_paths(album_data, d['number'], t['number'], t['title'])
            have = os.path.exists(path)
            tracks.append(dict(t, have=have, genres=read_file_genres(path) if have else []))
        out['discs'].append(dict(d, tracks=tracks))
    out['saved_genres'] = db_quiet(get_saved_genres, release_id)
    return out


def mpd_update():
    try:
        subprocess.run(['mpc', 'update'], capture_output=True, timeout=30)
    except Exception as e:
        print(f'mpc update failed: {e}', flush=True)


# ---------------------------------------------------------------- downloading one track
def run_track_download(release_id, disc_number, track_number, url, sid=''):
    """Download one track from a YouTube link, tag it from the album data, and file it
    under Artist/Album. Yields small dicts (log, percent, done, success, ...)."""

    def fail(message):
        return {'log': message, 'err': True, 'done': True, 'success': False}

    try:
        album_data = fetch_album(release_id)
    except MusicBrainzError as e:
        yield fail(str(e))
        return

    disc = next((d for d in album_data['discs'] if d['number'] == disc_number), None)
    track = None
    if disc:
        track = next((t for t in disc['tracks'] if t['number'] == track_number), None)
    if track is None:
        yield fail(f'Disc {disc_number}, track {track_number} is not on this album.')
        return

    album_dir, final_path = track_paths(album_data, disc_number, track_number, track['title'])
    final_name = os.path.basename(final_path)

    def already_have():
        return {'log': f'Already in your library: {final_name}', 'done': True,
                'success': True, 'skipped': True, 'percent': 100, 'filename': final_name}

    if os.path.exists(final_path):
        yield already_have()
        return

    tmp_dir = tempfile.mkdtemp(prefix='boss-army-')
    tmp_file = os.path.join(tmp_dir, 'track.mp3')
    proc = None
    try:
        cmd = [
            'yt-dlp',
            '--no-playlist',
            '--extract-audio',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--output', os.path.join(tmp_dir, 'track.%(ext)s'),
            '--newline',
            '--progress',
            '--', url
        ]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            preexec_fn=os.setsid
        )
        if sid:
            active_downloads[sid] = os.getpgid(proc.pid)

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            yield {'log': line}
            if '[download]' in line and '%' in line:
                try:
                    pct = float(line.split('%')[0].split()[-1])
                    yield {'percent': min(int(pct), 99)}
                except Exception:
                    pass

        proc.wait()
        active_downloads.pop(sid, None)

        if proc.returncode < 0:
            yield {'log': 'Download cancelled', 'done': True, 'success': False, 'cancelled': True}
            return
        if proc.returncode != 0 or not os.path.exists(tmp_file):
            yield fail('yt-dlp could not download that link. Check the logs above.')
            return

        yield {'log': 'Download finished. Tagging...', 'percent': 99}

        cover = None
        try:
            cover = get_cover_bytes(release_id)
            if cover is None:
                yield {'log': 'This album has no cover art, leaving it empty.'}
        except Exception as e:
            yield {'log': f'Could not get the cover ({e}). Continuing without it.', 'err': True}

        genres = db_quiet(get_saved_genres, release_id) or []
        try:
            apply_album_tags(tmp_file, album_data, disc_number, track_number, cover, genres)
        except Exception as e:
            yield fail(f'Tagging failed: {e}')
            return

        os.makedirs(album_dir, exist_ok=True)
        if os.path.exists(final_path):
            yield already_have()
            return

        # Move in under a temporary name first, so a half-copied file is never
        # mistaken for a finished one.
        part_path = final_path + '.part'
        shutil.move(tmp_file, part_path)
        os.replace(part_path, final_path)

        yield {'log': f'Saved: {os.path.relpath(final_path, MUSIC_BASE)}', 'done': True,
               'success': True, 'percent': 100, 'filename': final_name}
    except Exception as ex:
        yield fail(str(ex))
    finally:
        active_downloads.pop(sid, None)
        if proc is not None and proc.poll() is None:
            # The page went away (or something broke): don't leave yt-dlp running.
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------- background queue
# Jobs are kept in memory while they run and saved to the database, so a restart of the
# service picks up the tracks that were still waiting. Downloads keep going when the page
# is closed; the page just asks GET /queue every second or two.

MAX_PARALLEL = 2              # tracks downloading at the same time
MAX_BATCH = 100               # most tracks accepted in one request
JOB_KEEP_SECONDS = 6 * 3600   # finished jobs are forgotten after this long

JOBS = {}                     # job id -> job dict
JOBS_LOCK = threading.Lock()
JOB_QUEUE = queue.Queue()     # job ids waiting for a free worker
WORKERS = []
MPD_DIRTY = [False]           # something new was saved and MPD has not been told yet

ACTIVE_STATES = ('queued', 'running')


def ensure_workers():
    """Start the worker threads the first time they are needed."""
    with JOBS_LOCK:
        if WORKERS:
            return
        for n in range(MAX_PARALLEL):
            t = threading.Thread(target=worker_loop, name=f'dl-worker-{n}', daemon=True)
            t.start()
            WORKERS.append(t)


def prune_jobs():
    """Forget old finished jobs. Call with JOBS_LOCK held."""
    cutoff = time.time() - JOB_KEEP_SECONDS
    old = [j for j, job in JOBS.items()
           if job['state'] not in ACTIVE_STATES and job['finished_at'] < cutoff]
    for job_id in old:
        del JOBS[job_id]
        db_quiet(db_delete_job, job_id)


def job_view(job):
    return {k: job[k] for k in ('id', 'release', 'disc', 'track', 'title', 'artist', 'album',
                                'state', 'percent', 'message', 'filename')}


def claim_mpd_update():
    """True (once) when something new was saved and no job is left waiting or running.
    Call with JOBS_LOCK held."""
    if MPD_DIRTY[0] and not any(j['state'] in ACTIVE_STATES for j in JOBS.values()):
        MPD_DIRTY[0] = False
        return True
    return False


def finish_job(job, state, message, filename=''):
    """Mark a job finished, save it, and decide in one locked step whether this was the last
    job of the batch (so MPD gets exactly one library update). Returns True if the caller
    should run `mpc update`."""
    with JOBS_LOCK:
        job['state'] = state
        job['message'] = message[:200]
        job['finished_at'] = time.time()
        if state == 'done':
            job['percent'] = 100
            job['filename'] = filename
            MPD_DIRTY[0] = True
        elif state == 'skipped':
            job['percent'] = 100
            job['filename'] = filename
        snapshot = dict(job)
        update_now = claim_mpd_update()

    db_quiet(db_save_job, snapshot)
    if state in ('done', 'failed', 'cancelled'):
        db_quiet(db_add_history, snapshot)
    if state == 'done':
        db_quiet(db_bump_have, job['release'])
    if state in ('done', 'skipped'):
        db_quiet(set_link, job['release'], job['disc'], job['track'], '')   # the link has done its job
    return update_now


def run_job(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None or job['state'] != 'queued':
            return None, False          # cancelled while it waited
        job['state'] = 'running'
        job['message'] = 'Starting...'
        snapshot = dict(job)
    db_quiet(db_save_job, snapshot)

    final = None
    gen = run_track_download(job['release'], job['disc'], job['track'], job['url'], sid=job_id)
    try:
        for event in gen:
            with JOBS_LOCK:
                if 'log' in event:
                    job['log'].append(event['log'])
                    del job['log'][:-300]
                    job['message'] = event['log'][:200]
                if 'percent' in event:
                    job['percent'] = event['percent']
                if event.get('done'):
                    final = event
                stop = job['cancel_requested'] and not event.get('done')
            if stop:
                break
    finally:
        gen.close()

    if final is not None:
        if final.get('cancelled'):
            return job, finish_job(job, 'cancelled', 'Cancelled')
        if final.get('success'):
            state = 'skipped' if final.get('skipped') else 'done'
            return job, finish_job(job, state, final.get('log', ''), final.get('filename', ''))
        return job, finish_job(job, 'failed', final.get('log', 'Failed'))
    if job['cancel_requested']:
        return job, finish_job(job, 'cancelled', 'Cancelled')
    return job, finish_job(job, 'failed', 'Stopped unexpectedly')


def worker_loop():
    while True:
        job_id = JOB_QUEUE.get()
        update_now = False
        try:
            job, update_now = run_job(job_id)
            if job is None:
                # A cancelled job that never ran can still be the last one of a batch.
                with JOBS_LOCK:
                    update_now = claim_mpd_update()
        except Exception as e:
            # Never let one bad job kill the worker.
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if job is not None and job['state'] in ACTIVE_STATES:
                update_now = finish_job(job, 'failed', f'Internal error: {e}')
        if update_now:
            mpd_update()


def cleanup_temp_dirs():
    """Remove download folders left behind if the service was stopped mid-download."""
    root = tempfile.gettempdir()
    try:
        names = os.listdir(root)
    except OSError:
        return
    for name in names:
        if name.startswith('boss-army-'):
            shutil.rmtree(os.path.join(root, name), ignore_errors=True)


def restore_jobs():
    """After a restart: bring back saved jobs. Ones that were waiting or downloading start again."""
    try:
        with db() as conn:
            rows = [dict(r) for r in conn.execute('SELECT * FROM jobs ORDER BY created').fetchall()]
    except Exception as e:
        print(f'could not restore the queue: {e}', flush=True)
        return
    cutoff = time.time() - JOB_KEEP_SECONDS
    restart_ids = []
    with JOBS_LOCK:
        for r in rows:
            active = r['state'] in ACTIVE_STATES
            if not active and (r['finished_at'] or 0) < cutoff:
                continue
            job = {
                'id': r['id'], 'release': r['release_id'], 'disc': r['disc'], 'track': r['track'],
                'title': r['title'] or '', 'url': r['url'] or '', 'artist': r['artist'] or '',
                'album': r['album'] or '', 'state': r['state'], 'percent': r['percent'] or 0,
                'message': r['message'] or '', 'filename': r['filename'] or '',
                'log': [], 'cancel_requested': False,
                'created': r['created'] or time.time(), 'finished_at': r['finished_at'] or 0,
            }
            if active:
                job.update(state='queued', percent=0, message='Waiting... (after a restart)')
                restart_ids.append(job['id'])
            JOBS[job['id']] = job
    if restart_ids:
        ensure_workers()
        for job_id in restart_ids:
            JOB_QUEUE.put(job_id)
        print(f'restored {len(restart_ids)} unfinished downloads', flush=True)


def parse_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


# ---------------------------------------------------------------- routes
@app.route('/')
def index():
    return render_template('index.html', mympd_url=MYMPD_URL)


@app.route('/album')
def album():
    release_id = request.args.get('id', '').strip()
    if not UUID_RE.match(release_id):
        return jsonify({'error': 'That does not look like a MusicBrainz ID.'})
    try:
        page = album_for_page(release_id, fetch_album(release_id))
    except MusicBrainzError as e:
        return jsonify({'error': str(e)})
    have = sum(1 for d in page['discs'] for t in d['tracks'] if t['have'])
    # ?refresh=1 is the page re-reading an album it already shows: not a new visit
    db_quiet(db_record_open, release_id, page, have, not request.args.get('refresh'))
    return jsonify(page)


@app.route('/cover')
def cover():
    release_id = request.args.get('id', '').strip()
    if not UUID_RE.match(release_id):
        return jsonify({'error': 'That does not look like a MusicBrainz ID.'}), 400
    try:
        data = get_cover_bytes(release_id)
    except Exception as e:
        return jsonify({'error': f'Could not get the cover: {e}'}), 502
    if data is None:
        return '', 404
    mime = 'image/png' if data.startswith(b'\x89PNG') else 'image/jpeg'
    return Response(data, mimetype=mime, headers={'Cache-Control': 'public, max-age=86400'})


def pick_thumbnail(data):
    """A small-ish thumbnail URL from yt-dlp's video info."""
    thumbs = [t for t in data.get('thumbnails') or []
              if isinstance(t, dict) and str(t.get('url', '')).startswith('http')]
    small = [t for t in thumbs if (t.get('width') or 0) and t['width'] <= 480]
    if small:
        return max(small, key=lambda t: t['width'])['url']
    url = data.get('thumbnail') or (thumbs[-1]['url'] if thumbs else '')
    return url if str(url).startswith('http') else ''


@app.route('/linkinfo')
def linkinfo():
    """Look at a video link without downloading it: title, length, thumbnail."""
    url = request.args.get('url', '').strip()
    if not URL_RE.match(url) or len(url) > 2000:
        return jsonify({'error': 'Paste a full link that starts with http:// or https://'}), 400

    cached = LINKINFO_CACHE.get(url)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return jsonify(cached[1])

    try:
        with LINKINFO_SLOTS:
            result = subprocess.run(
                ['yt-dlp', '--no-playlist', '--skip-download', '--dump-json',
                 '--no-warnings', '--', url],
                capture_output=True, text=True, timeout=45
            )
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'That link took too long to answer.'}), 504
    except Exception as e:
        return jsonify({'error': f'Could not run yt-dlp: {e}'}), 500

    if result.returncode != 0:
        lines = [l for l in result.stderr.strip().splitlines() if l.strip()]
        reason = lines[-1].replace('ERROR: ', '')[:160] if lines else 'unknown error'
        return jsonify({'error': f'yt-dlp could not open that link: {reason}'}), 422
    try:
        data = json.loads(result.stdout.strip().splitlines()[0])
    except Exception:
        return jsonify({'error': 'yt-dlp gave an answer we could not read.'}), 502

    duration = data.get('duration')
    info = {
        'title': str(data.get('title') or '')[:200],
        'duration': round(duration) if isinstance(duration, (int, float)) else None,
        'thumbnail': pick_thumbnail(data),
    }
    if len(LINKINFO_CACHE) > 300:
        LINKINFO_CACHE.clear()
    LINKINFO_CACHE[url] = (time.time(), info)
    return jsonify(info)


# ---- finding the right video for a track (the way a person does it)
BAD_WORDS = ['cover', 'remix', 'live', 'sped up', 'slowed', 'reverb', 'nightcore', 'instrumental',
             'karaoke', '8d', 'acoustic', 'reaction', 'tutorial', 'lofi', 'mashup', 'bass boosted']
FIND_MATCH_SECONDS = 5
FIND_SLOTS = threading.Semaphore(2)          # at most two track searches at once


def norm_name(text):
    return re.sub(r'[\W_]+', '', str(text or '').casefold())


def artist_parts(artist):
    parts = re.split(r'\s*(?:&|,|;|\band\b|\bx\b|feat\.?|ft\.?|featuring|with)\s*', str(artist or ''), flags=re.I)
    return [norm_name(p) for p in parts if len(norm_name(p)) >= 2]


def channel_is_official(channel, artist, verified=False):
    """True only when the channel name is the artist's name (YouTube's own verified badge is
    not used: plenty of reupload channels are verified, and some real artists are not).
    "Ado - Topic", "AdoVEVO" and "Ado Official" count; "Adobe" or "Ado Lyrics" do not."""
    base = re.sub(r'\s*-\s*topic$', '', str(channel or ''), flags=re.I)
    ch = norm_name(base)
    for word in ('vevo', 'official', 'music'):
        ch = ch.replace(word, '')
    if not ch:
        return False
    return any(ch == a for a in artist_parts(artist) + [norm_name(artist)] if a)


def has_bad_word(video_title, track_title):
    vt, tt = str(video_title or '').lower(), str(track_title or '').lower()
    for w in BAD_WORDS:
        pat = r'(?<![a-z0-9])' + re.escape(w) + r'(?![a-z0-9])'
        if re.search(pat, vt) and not re.search(pat, tt):
            return True
    return False


def search_youtube(query, count=10):
    """Plain YouTube search through yt-dlp (no downloading). Returns a list of dicts."""
    with LINKINFO_SLOTS:
        result = subprocess.run(
            ['yt-dlp', '--flat-playlist', '--dump-json', '--no-warnings', f'ytsearch{count}:{query}'],
            capture_output=True, text=True, timeout=40)
    out = []
    for line in result.stdout.splitlines():
        try:
            d = json.loads(line)
        except Exception:
            continue
        vid = d.get('id')
        if not vid:
            continue
        out.append({
            'id': vid,
            'url': f'https://www.youtube.com/watch?v={vid}',
            'title': str(d.get('title') or '')[:200],
            'duration': d.get('duration') if isinstance(d.get('duration'), (int, float)) else None,
            'views': d.get('view_count') if isinstance(d.get('view_count'), (int, float)) else 0,
            'channel': str(d.get('channel') or d.get('uploader') or '')[:100],
            'verified': bool(d.get('channel_is_verified')),
            'thumbnail': pick_thumbnail(d) or f'https://i.ytimg.com/vi/{vid}/mqdefault.jpg',
        })
    return out


def video_detail(url):
    """Full look at one video: best audio bitrate and whether the channel is verified."""
    try:
        with LINKINFO_SLOTS:
            result = subprocess.run(['yt-dlp', '--no-playlist', '--skip-download', '--dump-json',
                                     '--no-warnings', '--', url],
                                    capture_output=True, text=True, timeout=45)
        data = json.loads(result.stdout.strip().splitlines()[0])
    except Exception:
        return {}
    rates = [f.get('abr') for f in data.get('formats') or []
             if isinstance(f, dict) and f.get('vcodec') in (None, 'none')
             and isinstance(f.get('abr'), (int, float))]
    return {
        'abr': round(max(rates)) if rates else None,
        'verified': bool(data.get('channel_is_verified')),
        'views': data.get('view_count') if isinstance(data.get('view_count'), (int, float)) else None,
    }


def rank_candidates(entries, artist, track_title, length, detail_fn=video_detail):
    """Pick the best videos for a track. Rules, in order:
    length must match the album, then a clean version (not live/remix/...), then the artist's
    own channel, then audio quality, then views."""
    cands = []
    for e in entries:
        if e.get('duration') is None:
            continue
        c = dict(e)
        c['match'] = (length is None) or abs(c['duration'] - length) <= FIND_MATCH_SECONDS
        c['dirty'] = has_bad_word(c['title'], track_title)
        c['official'] = channel_is_official(c['channel'], artist, c['verified'])
        c['topic'] = c['channel'].lower().endswith('- topic')
        c['abr'] = None
        cands.append(c)
    matching = [c for c in cands if c['match']]
    if matching:
        pool = matching
    else:                                           # nothing fits: show the closest ones, flagged
        pool = sorted(cands, key=lambda c: abs(c['duration'] - length))[:4]

    def pre(c):
        return (not c['dirty'], c['official'], c['views'] or 0)
    pool.sort(key=pre, reverse=True)

    finalists = pool[:3] if pool and pool[0]['match'] else []
    if finalists:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=3) as ex:
            details = list(ex.map(lambda c: detail_fn(c['url']), finalists))
        for c, d in zip(finalists, details):
            c['abr'] = d.get('abr')
            if d.get('views'):
                c['views'] = d['views']

        def final(c):
            bucket = round((c['abr'] or 0) / 32)
            return (not c['dirty'], c['official'], bucket, c['views'] or 0)
        finalists.sort(key=final, reverse=True)
        pool = finalists + [c for c in pool if c not in finalists]
    return pool[:4]


@app.route('/findlinks')
def findlinks():
    """Search YouTube for one track and return the best videos, best first."""
    release_id = request.args.get('release', '').strip().lower()
    disc, track = parse_int(request.args.get('disc')), parse_int(request.args.get('track'))
    if not UUID_RE.match(release_id) or disc is None or track is None:
        return jsonify({'error': 'Need a release ID, a disc and a track.'}), 400
    try:
        album = fetch_album(release_id)
    except MusicBrainzError as e:
        return jsonify({'error': str(e)}), 502
    found = None
    for d in album['discs']:
        for t in d['tracks']:
            if d['number'] == disc and t['number'] == track:
                found = t
    if not found:
        return jsonify({'error': 'That track is not on this album.'}), 404
    query = f"{found['title']} {album['artist']} lyrics"
    try:
        with FIND_SLOTS:
            entries = search_youtube(query)
            picks = rank_candidates(entries, album['artist'], found['title'], found['length'])
            if not any(c.get('match') and c.get('official') and not c.get('dirty') for c in picks):
                # no official upload with the right length: the artist's own upload often has no
                # "lyrics" in its title, so try the plain search once and merge
                seen = {e['id'] for e in entries}
                more = [e for e in search_youtube(f"{found['title']} {album['artist']}") if e['id'] not in seen]
                if more:
                    picks = rank_candidates(entries + more, album['artist'], found['title'], found['length'])
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'YouTube took too long to answer.'}), 504
    except Exception as e:
        return jsonify({'error': f'Search failed: {e}'}), 500
    keep = ('url', 'title', 'duration', 'thumbnail', 'channel', 'views', 'official', 'topic', 'abr', 'match')
    return jsonify({'results': [{k: c.get(k) for k in keep} for c in picks]})


# ---- pasted links, remembered per album
@app.route('/links')
def links_get():
    release_id = request.args.get('release', '').strip()
    if not UUID_RE.match(release_id):
        return jsonify({'error': 'That does not look like a MusicBrainz ID.'}), 400
    try:
        return jsonify({'links': get_links(release_id)})
    except Exception as e:
        return jsonify({'error': f'Database problem: {e}'}), 500


@app.route('/links', methods=['POST'])
def links_set():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'Send JSON like {"release": "...", "links": [...]}'}), 400
    release_id = str(body.get('release', '')).strip()
    items = body.get('links')
    if not UUID_RE.match(release_id) or not isinstance(items, list) or len(items) > 200:
        return jsonify({'error': 'Need a release ID and a list of at most 200 links.'}), 400
    saved = 0
    try:
        for item in items:
            item = item if isinstance(item, dict) else {}
            disc, track = parse_int(item.get('disc')), parse_int(item.get('track'))
            url = str(item.get('url', '')).strip()
            if disc is None or track is None or (url and (not URL_RE.match(url) or len(url) > 2000)):
                continue
            set_link(release_id, disc, track, url)
            saved += 1
    except Exception as e:
        return jsonify({'error': f'Database problem: {e}'}), 500
    return jsonify({'saved': saved})


# ---- genres
@app.route('/genre/suggest')
def genre_suggest():
    release_id = request.args.get('id', '').strip()
    if not UUID_RE.match(release_id):
        return jsonify({'error': 'That does not look like a MusicBrainz ID.'}), 400
    try:
        return jsonify({'suggestions': genre_suggestions(release_id)})
    except MusicBrainzError as e:
        return jsonify({'error': str(e)}), 502


@app.route('/genre/save', methods=['POST'])
def genre_save():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'Send JSON like {"release": "...", "genres": [...]}'}), 400
    release_id = str(body.get('release', '')).strip()
    genres = clean_genres(body.get('genres'))
    if not UUID_RE.match(release_id) or genres is None:
        return jsonify({'error': 'Need a release ID and a list of genres.'}), 400
    try:
        album_data = fetch_album(release_id)
    except MusicBrainzError as e:
        return jsonify({'error': str(e)}), 502
    try:
        save_genres(release_id, album_data, genres)
    except Exception as e:
        return jsonify({'error': f'Database problem: {e}'}), 500
    return jsonify({'genres': genres})


@app.route('/genre/apply', methods=['POST'])
def genre_apply():
    """Write the album's chosen genres into the files that are already in the library."""
    body = request.get_json(silent=True)
    release_id = str((body or {}).get('release', '')).strip() if isinstance(body, dict) else ''
    if not UUID_RE.match(release_id):
        return jsonify({'error': 'That does not look like a MusicBrainz ID.'}), 400
    try:
        album_data = fetch_album(release_id)
        genres = get_saved_genres(release_id)
    except MusicBrainzError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Database problem: {e}'}), 500
    if genres is None:
        return jsonify({'error': 'Choose a genre first.'}), 400

    updated = unchanged = failed = 0
    for d in album_data['discs']:
        for t in d['tracks']:
            _, path = track_paths(album_data, d['number'], t['number'], t['title'])
            if not os.path.exists(path):
                continue
            if same_genres(read_file_genres(path), genres):
                unchanged += 1
                continue
            try:
                write_file_genres(path, genres)
                updated += 1
            except Exception as e:
                print(f'could not write genre to {path}: {e}', flush=True)
                failed += 1
    if updated:
        mpd_update()
    return jsonify({'updated': updated, 'unchanged': unchanged, 'failed': failed})


# ---- the queue
@app.route('/queue', methods=['POST'])
def queue_add():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': 'Send JSON like {"release": "...", "tracks": [...]}'}), 400
    release_id = str(body.get('release', '')).strip()
    tracks = body.get('tracks')
    if not UUID_RE.match(release_id):
        return jsonify({'error': 'That does not look like a MusicBrainz ID.'}), 400
    if not isinstance(tracks, list) or not tracks:
        return jsonify({'error': 'Pick at least one track.'}), 400
    if len(tracks) > MAX_BATCH:
        return jsonify({'error': f'At most {MAX_BATCH} tracks at a time.'}), 400
    try:
        album_data = fetch_album(release_id)
    except MusicBrainzError as e:
        return jsonify({'error': str(e)}), 502

    ensure_workers()
    results = []
    new_jobs = []
    replaced = []
    with JOBS_LOCK:
        prune_jobs()
        for item in tracks:
            item = item if isinstance(item, dict) else {}
            disc_number = parse_int(item.get('disc'))
            track_number = parse_int(item.get('track'))
            url = str(item.get('url', '')).strip()
            row = {'disc': disc_number, 'track': track_number}

            def reject(message):
                row.update(status='rejected', message=message)
                results.append(row)

            if disc_number is None or track_number is None:
                reject('Disc and track must be numbers.')
                continue
            if not URL_RE.match(url) or len(url) > 2000:
                reject('Paste a full link that starts with http:// or https://')
                continue
            disc = next((d for d in album_data['discs'] if d['number'] == disc_number), None)
            track = disc and next((t for t in disc['tracks'] if t['number'] == track_number), None)
            if not track:
                reject(f'Disc {disc_number}, track {track_number} is not on this album.')
                continue

            old = next((j for j in JOBS.values()
                        if (j['release'], j['disc'], j['track']) ==
                        (release_id, disc_number, track_number)), None)
            if old and old['state'] in ACTIVE_STATES:
                reject('Already queued or downloading.')
                continue

            _, final_path = track_paths(album_data, disc_number, track_number, track['title'])
            if os.path.exists(final_path):
                row.update(status='skipped', message='Already in your library.')
                results.append(row)
                continue

            if old:
                del JOBS[old['id']]      # a finished or failed try is replaced by the new one
                replaced.append(old['id'])
            job_id = uuid.uuid4().hex[:12]
            job = {
                'id': job_id, 'release': release_id, 'disc': disc_number,
                'track': track_number, 'title': track['title'], 'url': url,
                'artist': album_data['artist'], 'album': album_data['title'],
                'state': 'queued', 'percent': 0, 'message': 'Waiting...', 'filename': '',
                'log': [], 'cancel_requested': False,
                'created': time.time(), 'finished_at': 0,
            }
            JOBS[job_id] = job
            new_jobs.append(dict(job))
            row.update(status='queued', id=job_id)
            results.append(row)

    for old_id in replaced:
        db_quiet(db_delete_job, old_id)
    for job in new_jobs:
        db_quiet(db_save_job, job)
    for job in new_jobs:
        JOB_QUEUE.put(job['id'])
    return jsonify({'results': results, 'queued': len(new_jobs)})


@app.route('/queue')
def queue_list():
    release_id = request.args.get('release', '').strip()
    with JOBS_LOCK:
        prune_jobs()
        jobs = sorted(JOBS.values(), key=lambda j: j['created'])
        if release_id:
            jobs = [j for j in jobs if j['release'] == release_id]
        return jsonify({
            'jobs': [job_view(j) for j in jobs],
            'running': sum(1 for j in jobs if j['state'] == 'running'),
            'waiting': sum(1 for j in jobs if j['state'] == 'queued'),
        })


@app.route('/queue/cancel', methods=['POST'])
def queue_cancel():
    job_id = request.args.get('id', '').strip()
    release_id = request.args.get('release', '').strip()
    if not job_id and not release_id:
        return jsonify({'error': 'Give an id or a release.'}), 400

    cancelled = 0
    to_kill = []
    saved = []
    with JOBS_LOCK:
        for job in JOBS.values():
            if job['state'] not in ACTIVE_STATES:
                continue
            if (job_id and job['id'] != job_id) or (release_id and job['release'] != release_id):
                continue
            cancelled += 1
            if job['state'] == 'queued':
                job['state'] = 'cancelled'
                job['message'] = 'Cancelled'
                job['finished_at'] = time.time()
                saved.append(dict(job))
            else:
                job['cancel_requested'] = True
                job['message'] = 'Cancelling...'
                to_kill.append(job['id'])
    for snapshot in saved:
        db_quiet(db_save_job, snapshot)
        db_quiet(db_add_history, snapshot)
    for jid in to_kill:
        pgid = active_downloads.get(jid)
        if pgid:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    return jsonify({'cancelled': cancelled})


@app.route('/queue/log')
def queue_log():
    job_id = request.args.get('id', '').strip()
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({'error': 'No such job.'}), 404
        return jsonify({'id': job_id, 'state': job['state'], 'log': list(job['log'])})


@app.route('/albums')
def albums_list():
    """Albums that were looked up, most recently opened first."""
    limit = min(parse_int(request.args.get('limit', '60')) or 60, 200)
    try:
        with db() as conn:
            rows = conn.execute('SELECT * FROM opened_albums ORDER BY last_opened DESC LIMIT ?',
                                (limit,)).fetchall()
    except Exception as e:
        return jsonify({'error': f'Database problem: {e}'}), 500
    return jsonify({'albums': [dict(r) for r in rows]})


@app.route('/albums/forget', methods=['POST'])
def albums_forget():
    """Take an album off the list. Files, links and the chosen genre are left alone."""
    body = request.get_json(silent=True)
    release_id = str(body.get('release', '')).strip() if isinstance(body, dict) else ''
    if not UUID_RE.match(release_id):
        return jsonify({'error': 'That does not look like a MusicBrainz ID.'}), 400
    try:
        with db() as conn:
            conn.execute('DELETE FROM opened_albums WHERE release_id = ?', (release_id,))
    except Exception as e:
        return jsonify({'error': f'Database problem: {e}'}), 500
    return jsonify({'ok': True})


@app.route('/history')
def history():
    """The most recent finished downloads (done, failed or cancelled), newest first."""
    limit = min(parse_int(request.args.get('limit', '50')) or 50, 200)
    try:
        with db() as conn:
            rows = conn.execute('SELECT * FROM history ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
    except Exception as e:
        return jsonify({'error': f'Database problem: {e}'}), 500
    return jsonify({'history': [dict(r) for r in rows]})


if __name__ == '__main__':
    cleanup_temp_dirs()
    restore_jobs()
    app.run(host=os.environ.get('HOST', '0.0.0.0'), port=int(os.environ.get('PORT', '8083')),
            debug=False, threaded=True)
