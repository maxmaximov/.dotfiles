#!/usr/bin/env python3
"""Run the opencode TUI headless and check what it drew.

Usage: tui-screen.py SECONDS STRING...

Opens the latest top-level session that has been idle for more than a day (so no live session is touched) in a 200x50
pseudo-terminal, waits SECONDS, rebuilds the final screen from the escape sequences, prints the rows starting at the
topmost STRING found and exits 0 only if every STRING is in the session sidebar. Only the sidebar is searched, so text
of the session messages cannot match. The environment passes through, so OPENCODE_TUI_CONFIG can add plugins.
The opencode process group is killed afterwards.
"""
import fcntl, os, pty, re, select, shutil, signal, sqlite3, struct, sys, termios, time, unicodedata

ROWS, COLS = 50, 200
SIDEBAR = COLS - 42  # the session sidebar is the rightmost 42 columns
DB = os.path.expanduser('~/.local/share/opencode/opencode.db')
CSI = re.compile(r'\x1b\[([0-?]*)[ -/]*([@-~])')
SKIP = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^].*?\x1b\\|\x1b[ -/]*[0-~]', re.S)


def idle_session():
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    try:
        rows = db.execute(
            'SELECT id, directory FROM session WHERE parent_id IS NULL AND time_updated < ? '
            'ORDER BY time_updated DESC LIMIT 20',
            (int((time.time() - 86400) * 1000),),
        ).fetchall()
    finally:
        db.close()
    for session, directory in rows:
        if os.path.isdir(directory):
            return session, directory
    sys.exit('no idle session with an existing directory')


def capture(seconds):
    session, directory = idle_session()
    print(f'session {session}')
    binary = shutil.which('opencode')
    if not binary:
        sys.exit('opencode is not on PATH')
    env = {k: v for k, v in os.environ.items() if k not in ('OPENCODE', 'OPENCODE_PID')}
    env.update(TERM='xterm-256color', COLORTERM='truecolor')
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        os.chdir(directory)
        os.execve(binary, [binary, '-s', session], env)
    raw = bytearray()
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.2)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw += chunk
        if b'\x1b[c' in chunk:
            os.write(fd, b'\x1b[?62;22c')  # answer the primary device attributes query
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            break
        for _ in range(30):
            if os.waitpid(pid, os.WNOHANG)[0]:
                return raw
            time.sleep(0.1)
    return raw


def render(text):
    grid = [[' '] * COLS for _ in range(ROWS)]
    r = c = i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\x1b':
            m = CSI.match(text, i)
            if not m:
                s = SKIP.match(text, i)
                i = s.end() if s else i + 1
                continue
            params, final = m.groups()
            nums = [int(p) if p.isdigit() else 0 for p in params.lstrip('?<>=').split(';')]
            n = nums[0] or 1
            if final in 'Hf':
                r, c = n - 1, (nums[1] if len(nums) > 1 and nums[1] else 1) - 1
            elif final == 'A':
                r -= n
            elif final == 'B':
                r += n
            elif final == 'C':
                c += n
            elif final == 'D':
                c -= n
            elif final == 'G':
                c = n - 1
            elif final == 'd':
                r = n - 1
            elif final == 'J' and nums[0] in (2, 3) or final == 'h' and params == '?1049':
                grid = [[' '] * COLS for _ in range(ROWS)]
            elif final == 'J' and nums[0] == 0 and 0 <= r < ROWS:
                grid[r][max(c, 0):] = [' '] * (COLS - max(c, 0))
                for row in grid[r + 1:]:
                    row[:] = [' '] * COLS
            elif final == 'K' and 0 <= r < ROWS:
                lo, hi = {0: (c, COLS), 1: (0, c + 1), 2: (0, COLS)}.get(nums[0], (0, 0))
                grid[r][max(lo, 0):hi] = [' '] * (hi - max(lo, 0))
            elif final == 'X' and 0 <= r < ROWS:
                grid[r][max(c, 0):c + n] = [' '] * len(grid[r][max(c, 0):c + n])
            r, c = min(max(r, 0), ROWS - 1), max(c, 0)
            i = m.end()
            continue
        if ch == '\r':
            c = 0
        elif ch == '\n':
            r = min(r + 1, ROWS - 1)
        elif ch == '\b':
            c = max(c - 1, 0)
        elif ch >= ' ' and ch != '\x7f' and not unicodedata.combining(ch):
            wide = unicodedata.east_asian_width(ch) in ('W', 'F')
            if c < COLS:
                grid[r][c] = ch
            if wide and c + 1 < COLS:
                grid[r][c + 1] = ''  # the right half of a wide character
            c += 2 if wide else 1
        i += 1
    return grid


def find(grid, needle):
    for r, row in enumerate(grid):
        cells = row[SIDEBAR:]
        at = ''.join(cells).find(needle)
        if at < 0:
            continue
        seen = 0
        for col, cell in enumerate(cells):
            if seen == at and cell:
                return r, SIDEBAR + col
            seen += len(cell)
    return None


def main():
    seconds, *needles = sys.argv[1:]
    grid = render(capture(float(seconds)).decode('utf-8', 'replace'))
    spots = {n: find(grid, n) for n in needles}
    first = min((spot for spot in spots.values() if spot), default=None)
    if first:
        r, col = first
        for row in grid[r:r + 7]:
            print('  | ' + ''.join(row[col:]).rstrip())
    missing = [n for n, spot in spots.items() if not spot]
    print(f'missing in the sidebar: {missing}' if missing else 'all strings drawn')
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
