/**
 * The scan that runs ON the remote machine, fed to `python3 -` over ssh.
 *
 * It is a deliberate port of the local Codex scan rather than a data dump: a rollout can be tens of
 * megabytes, and shipping raw files to Windows for every refresh would be absurd. Only the summed
 * rows come back. Keep it to the standard library and to syntax that both a macOS and a Debian
 * python3 accept — this is the one piece of subtrack that must run on someone else's machine.
 *
 * Contract: argv is `<windowStartMs> <nowMs>`, and stdout is one JSON object:
 *   { rows: [{accountId, sessionId, cwd, models, replies, input, cacheWrite, cacheRead, output,
 *             firstMs, lastMs}], shared: [store paths owned by more than one login], warnings: [] }
 */
export const REMOTE_CODEX_SCAN = String.raw`
import calendar, json, os, re, sys, time

WINDOW_START_MS = int(sys.argv[1])
NOW_MS = int(sys.argv[2])
HOME = os.path.expanduser('~')
ROOTS = [os.path.join(HOME, '.codex'),
         os.path.join(HOME, '.codex-homes'),
         os.path.join(HOME, '.subtrack', 'codex-homes')]
HEAD_BYTES = 256 * 1024
MAX_TAIL_BYTES = 64 * 1024 * 1024
DAY_MS = 86400000
TS_RE = re.compile(r'"timestamp"\s*:\s*"([^"]+)"')

warnings = []

def ts_ms(text):
    try:
        base = calendar.timegm(time.strptime(text[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
        if len(text) > 20 and text[19] == '.':
            return base + int(text[20:23].ljust(3, '0'))
        return base
    except Exception:
        return None

def account_id(home):
    try:
        with open(os.path.join(home, 'auth.json'), 'r') as handle:
            data = json.load(handle)
    except Exception:
        return None
    tokens = data.get('tokens') or {}
    shared = (data.get('providers') or {}).get('openai-codex') or {}
    return (tokens.get('account_id')
            or (shared.get('tokens') or {}).get('account_id')
            or shared.get('account_id')
            or data.get('account_id'))

def homes():
    found = []
    for root in ROOTS:
        if os.path.isfile(os.path.join(root, 'auth.json')):
            found.append(root)
        try:
            for name in sorted(os.listdir(root)):
                path = os.path.join(root, name)
                if os.path.isdir(path):
                    found.append(path)
        except Exception:
            pass
    return found

# Folder names a window can touch, in THIS machine's local time -- Codex names them locally, so the
# remote host's own timezone is the right one, not the dashboard's.
def day_keys():
    keys = set()
    at = WINDOW_START_MS - DAY_MS
    while at <= NOW_MS + DAY_MS:
        keys.add(time.strftime('%Y/%m/%d', time.localtime(at / 1000.0)))
        at += DAY_MS
    keys.add(time.strftime('%Y/%m/%d', time.localtime((NOW_MS + DAY_MS) / 1000.0)))
    return keys

DAYS = day_keys()

def window_files(store):
    out = []
    try:
        years = [name for name in os.listdir(store) if len(name) == 4 and name.isdigit()]
    except Exception:
        return out
    for year in years:
        try:
            months = os.listdir(os.path.join(store, year))
        except Exception:
            continue
        for month in months:
            try:
                days = os.listdir(os.path.join(store, year, month))
            except Exception:
                continue
            for day in days:
                if '%s/%s/%s' % (year, month, day) not in DAYS:
                    continue
                folder = os.path.join(store, year, month, day)
                try:
                    names = os.listdir(folder)
                except Exception:
                    continue
                for name in names:
                    if not name.endswith('.jsonl'):
                        continue
                    path = os.path.join(folder, name)
                    try:
                        info = os.stat(path)
                    except Exception:
                        continue
                    if info.st_size == 0 or info.st_mtime * 1000 < WINDOW_START_MS:
                        continue
                    out.append((path, info.st_size))
    return out

def read_chunk(path, start, length):
    with open(path, 'rb') as handle:
        handle.seek(start)
        return handle.read(length).decode('utf-8', 'replace')

def window_lines(path, size):
    take = min(size, 1024 * 1024)
    while True:
        start = size - take
        lines = read_chunk(path, start, take).split('\n')
        if start > 0:
            lines = lines[1:]   # the first line is cut mid-record
        earliest = None
        for line in lines:      # records are appended in time order: the first stamp is the earliest
            found = TS_RE.search(line)
            if found:
                earliest = ts_ms(found.group(1))
                break
        if start == 0 or (earliest is not None and earliest < WINDOW_START_MS):
            return lines, False
        if take >= MAX_TAIL_BYTES or take >= size:
            return lines, take < size
        take = min(size, take * 4)

def read_head(path, size):
    session_id = cwd = model = None
    try:
        head = read_chunk(path, 0, min(size, HEAD_BYTES))
    except Exception:
        return session_id, cwd, model
    for line in head.split('\n'):
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue    # a truncated last line is expected
        payload = record.get('payload') or {}
        if record.get('type') == 'session_meta':
            session_id = payload.get('session_id') or payload.get('id')
            cwd = payload.get('cwd')
        elif record.get('type') == 'turn_context' and not model:
            model = payload.get('model')
        if session_id and cwd and model:
            break
    return session_id, cwd, model

def usage_of(raw):
    if not isinstance(raw, dict):
        return None
    total = raw.get('input_tokens') or 0
    cached = raw.get('cached_input_tokens') or 0
    # Codex folds the cached part into input_tokens; split it so both providers report the same four.
    return (max(0, total - cached), raw.get('cache_write_input_tokens') or 0, cached, raw.get('output_tokens') or 0)

owners = {}
for home in homes():
    who = account_id(home)
    if not who:
        continue
    try:
        store = os.path.realpath(os.path.join(home, 'sessions'))
    except Exception:
        continue
    if not os.path.isdir(store):
        continue
    owners.setdefault(store, set()).add(who)

rows = {}
shared = []
for store, who in owners.items():
    if len(who) > 1:
        if window_files(store):
            shared.append(store)
        continue
    account = list(who)[0]
    for path, size in window_files(store):
        try:
            lines, truncated = window_lines(path, size)
        except Exception as error:
            warnings.append('%s: %s' % (os.path.basename(path), error))
            continue
        if truncated:
            warnings.append('%s: only the last 64 MiB were read' % os.path.basename(path))
        session_id, cwd, model = read_head(path, size)
        records, counts, models = [], [], {}
        seen = set()
        for line in lines:
            if '"token_usage_record"' not in line and '"token_count"' not in line and '"turn_context"' not in line:
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue
            payload = record.get('payload') or {}
            if record.get('type') == 'turn_context':
                name = payload.get('model')
                if name:
                    models[name] = models.get(name, 0) + 1
                if not cwd and payload.get('cwd'):
                    cwd = payload.get('cwd')
                continue
            at = ts_ms(record.get('timestamp') or '')
            if at is None or at < WINDOW_START_MS or at > NOW_MS:
                continue
            if record.get('type') == 'token_usage_record':
                use = usage_of(payload.get('usage'))
                if use:
                    response = payload.get('response_id')
                    if response and response in seen:
                        continue
                    if response:
                        seen.add(response)
                    records.append((at, use))
            elif record.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                use = usage_of((payload.get('info') or {}).get('last_token_usage'))
                if use:
                    counts.append((at, use))
        # CLI 0.153 writes both kinds and summing both double-counts; 0.147 writes only the events.
        chosen = records if records else counts
        if not chosen:
            continue
        key = (account, session_id or os.path.basename(path)[:-6])
        row = rows.get(key)
        if row is None:
            row = {'accountId': account, 'sessionId': key[1], 'cwd': cwd, 'models': {},
                   'replies': 0, 'input': 0, 'cacheWrite': 0, 'cacheRead': 0, 'output': 0,
                   'firstMs': None, 'lastMs': None}
            rows[key] = row
        if cwd and not row['cwd']:
            row['cwd'] = cwd
        for at, (fresh, write, cached, output) in chosen:
            row['input'] += fresh
            row['cacheWrite'] += write
            row['cacheRead'] += cached
            row['output'] += output
            row['replies'] += 1
            row['firstMs'] = at if row['firstMs'] is None else min(row['firstMs'], at)
            row['lastMs'] = at if row['lastMs'] is None else max(row['lastMs'], at)
        if not models and model:
            models[model] = 1
        for name, count in models.items():
            row['models'][name] = row['models'].get(name, 0) + count

print(json.dumps({'rows': list(rows.values()), 'shared': shared, 'warnings': warnings}))
`;
