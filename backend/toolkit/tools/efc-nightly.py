#!/usr/bin/env python3
"""Nightly EFC update for AMA Gradings: turns EFC Assessment Query results into small SQL statements.

Used by the nightly scheduled task, after it has run the Zapier "EFC Aquila: Assessment Query" for each program and school.
It reads those results from the task's own session log (and the files big results are saved to), so nothing is copied by hand.

  python3 efc-nightly.py collect            -> OUT/update_NN.sql: select cb_efc_update(program, school, [[id, grade, promoted, attended], ...])
                                               OUT/bbc.sql: select cb_bbc_seen([...]): everyone enrolled in Black Belt Club
                                               OUT/full.json: every row, for adding new members
  python3 efc-nightly.py new ID [ID ...]    -> OUT/new_NN.sql: select cb_load_efc(...) with names and contacts, for members not in Supabase yet
  python3 efc-nightly.py new --stdin        -> the same, with the IDs (or the JSON the update statements returned) read from stdin

OUT is /tmp/efc-nightly (or $EFC_OUT). Contains no student data itself: it only reads what this run pulled from EFC.
"""
import glob, json, os, re, sys
from collections import defaultdict

OUT = os.environ.get('EFC_OUT', '/tmp/efc-nightly')
# Reference prefix -> school (AU-023-1234 is Marrickville)
SCHOOLS = {'AU-023': 'Marrickville', 'AU-256': 'Sydenham', 'AU-258': 'Concord', 'AU-257': 'West', 'AU-3096': 'Sylvania'}
PROGRAMS = {'Taekwondo', 'Taekwondo - Little Dragon', 'Kung Fu', 'Kick Boxing', 'BJJ', 'BJJ Kids', 'Tricking'}
CLUB = 'Black Belt Club'                     # only who is in it is kept (no balances)
TEST_ACCOUNTS = ('c804b6eb', 'f2a1e6fd')   # EFC's own test members (Jarrod EFC, Sydenham EFC)
CAP = 200                                   # EFC returns at most 200 rows per query


def school_of(ref):
    m = re.match(r'^(AU-\d+)-', ref or '')
    return SCHOOLS.get(m.group(1)) if m else None


def texts():
    """Every tool result in the newest session log, plus the files large results were saved to."""
    logs = sorted(glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')), key=os.path.getmtime)
    if not logs:
        sys.exit('No session log found.')
    log = logs[-1]
    for line in open(log, encoding='utf-8'):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        c = (o.get('message') or {}).get('content')
        if not isinstance(c, list):
            continue
        for b in c:
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                cc = b.get('content')
                yield cc if isinstance(cc, str) else ''.join(x.get('text', '') for x in (cc or []) if isinstance(x, dict))
    for f in glob.glob(os.path.join(log[:-len('.jsonl')], 'tool-results', '*')):
        try:
            yield open(f, encoding='utf-8').read()
        except OSError:
            pass


def result_lists():
    for t in texts():
        t = t.strip()
        if not t.startswith('{"results"'):
            continue
        try:
            res = json.loads(t).get('results')
        except ValueError:
            continue
        if isinstance(res, list) and res and isinstance(res[0], dict) and 'grade' in res[0] and 'programme' in res[0]:
            yield res


def collect():
    os.makedirs(OUT, exist_ok=True)
    full, seen, warn, bbc = {}, set(), [], set()
    groups = defaultdict(list)   # (program, school) -> compact rows
    for res in result_lists():
        prog = (res[0].get('programme') or {}).get('name')
        if len(res) >= CAP:
            warn.append(f"{prog} at {school_of(res[0]['member'].get('reference')) or '?'} returned {len(res)} rows (EFC's limit): split that query by age (agefrom/ageto) so no one is missed.")
        for x in res:
            m, p = x.get('member') or {}, (x.get('programme') or {}).get('name')
            if p == CLUB and m.get('id') and not m['id'].startswith(TEST_ACCOUNTS):
                bbc.add(m['id'])
                continue
            if not m.get('id') or p not in PROGRAMS or m['id'].startswith(TEST_ACCOUNTS):
                continue
            if (p, m['id']) in seen:
                continue
            seen.add((p, m['id']))
            loc = school_of(m.get('reference'))
            contact = ' '.join(filter(None, [(m.get('contactFirstName') or '').strip(), (m.get('contactLastName') or '').strip()]))
            full[f"{p}|{m['id']}"] = [p, loc, [m['id'], m.get('reference') or '', (m.get('firstName') or '').strip(), (m.get('lastName') or '').strip(),
                                             m.get('dob') or '', contact, (m.get('eMail') or '').strip(), m.get('telephoneMobile') or '',
                                             (x.get('grade') or {}).get('name') or '', x.get('promoted') or '', x.get('attended') or 0]]
            groups[(p, loc)].append([m['id'], (x.get('grade') or {}).get('name') or '', x.get('promoted') or '', x.get('attended') or 0])
    for f in glob.glob(os.path.join(OUT, '*.sql')):
        os.remove(f)
    n, stmts = 0, []
    for (p, loc), rows in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1] or '')):
        for i in range(0, len(rows), 300):
            stmts.append(f"select cb_efc_update({q(p)}, {q(loc) if loc else 'null'}, $j${json.dumps(rows[i:i + 300], separators=(',', ':'), ensure_ascii=False)}$j$::jsonb) as r")
    # A few statements per file (each file is one SQL call): about 40 KB each
    batch, size = [], 0
    for st in stmts:
        if batch and size + len(st) > 40000:
            n += 1; write(f'update_{n:02d}.sql', batch); batch, size = [], 0
        batch.append(st); size += len(st)
    if batch:
        n += 1; write(f'update_{n:02d}.sql', batch)
    if bbc:
        open(os.path.join(OUT, 'bbc.sql'), 'w').write("select cb_bbc_seen(array[" + ','.join(q(i) for i in sorted(bbc)) + "]) as black_belt_club;")
    json.dump(full, open(os.path.join(OUT, 'full.json'), 'w'), ensure_ascii=False)
    print(f'{len(full)} rows from EFC in {len(groups)} program/school groups -> {n} update file(s) in {OUT}')
    for (p, loc), rows in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1] or '')):
        print(f'  {p} / {loc}: {len(rows)}')
    print(f'  {CLUB}: {len(bbc)} member(s) -> {"bbc.sql" if bbc else "no file (no Black Belt Club results)"}')
    for w in warn:
        print('WARNING: ' + w)


def write(name, stmts):
    open(os.path.join(OUT, name), 'w', encoding='utf-8').write(stmts[0] + ';' if len(stmts) == 1 else
        'select jsonb_agg(r) from (\n' + '\nunion all\n'.join(stmts) + '\n) x;')


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def new(ids):
    full = json.load(open(os.path.join(OUT, 'full.json'), encoding='utf-8'))
    want = set(ids)
    groups = defaultdict(list)
    for key, (p, loc, row) in full.items():
        if row[0] in want:
            groups[(p, loc)].append(row)
    for f in glob.glob(os.path.join(OUT, 'new_*.sql')):
        os.remove(f)
    n = 0
    for (p, loc), rows in groups.items():
        for i in range(0, len(rows), 60):
            n += 1
            open(os.path.join(OUT, f'new_{n:02d}.sql'), 'w', encoding='utf-8').write(
                f"select cb_load_efc({q(p)}, {q(loc or 'Marrickville')}, $j${json.dumps(rows[i:i + 60], separators=(',', ':'), ensure_ascii=False)}$j$::jsonb);")
    print(f'{sum(len(r) for r in groups.values())} new member row(s) -> {n} file(s) in {OUT}')


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] not in ('collect', 'new'):
        sys.exit(__doc__)
    if a[0] == 'collect':
        collect()
    else:
        ids = a[1:]
        if ids == ['--stdin']:
            ids = re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', sys.stdin.read())
        new(ids)
