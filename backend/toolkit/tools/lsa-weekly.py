#!/usr/bin/env python3
"""Weekly EFC check for long service awards (AMA Toolkit, /awards/).

EFC doesn't send anyone's enrolled date, but its Member Query can filter by "enrolled between X and Y weeks ago". This helper
plans those queries around this year's award window, and afterwards works out, for everyone found, the range of dates their
EFC enrolled date falls in. It reads the query results from the scheduled task's own session log, so nothing is copied by hand.

  python3 lsa-weekly.py plan     -> prints the first queries to run (one per school and milestone), one JSON per line
  python3 lsa-weekly.py more     -> prints follow-up queries (narrower date bands, or age splits when EFC's 50-row page is full).
                                    Run them, then run "more" again, until it prints nothing.
  python3 lsa-weekly.py collect  -> OUT/lsa.sql: select lsa_load('[{id, ref, name, loc, from, to}, ...]')  (names only, no contacts)

OUT is /tmp/lsa-weekly (or $LSA_OUT). The award year is this calendar year (the order goes in each December). The window
covers anniversaries from 1 January this year to 30 June next year, so the page can apply any leeway of up to 6 months.
Contains no student data itself.
"""
import glob, json, math, os, re, sys
from datetime import date, timedelta

OUT = os.environ.get('LSA_OUT', '/tmp/lsa-weekly')
SCHOOLS = {  # EFC location id -> school
    'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58': 'Marrickville', '5af07764-95bc-4caf-b889-ba846e409dc5': 'Sydenham',
    '7ca1c142-be41-4d02-b5eb-13534b23043b': 'Concord', 'eafda575-a10e-4656-a045-8e20201aad40': 'West',
    'a5a5ab24-e85d-4e14-ac16-1d9c189ff0dd': 'Sylvania'}
PREFIX = {'AU-023': 'Marrickville', 'AU-256': 'Sydenham', 'AU-258': 'Concord', 'AU-257': 'West', 'AU-3096': 'Sylvania'}
YEARS = range(5, 45, 5)          # 5, 10 ... 40 years
PAGE = 50                         # EFC's Member Query returns at most 50 rows
AGES = [(1, 8), (9, 12), (13, 17), (18, 39), (40, 100)]
TEST_ACCOUNTS = ('c804b6eb', 'f2a1e6fd')   # EFC's own test members
SLACK = 4                         # days either side, in case EFC rounds weeks differently


def today():
    d = os.environ.get('LSA_TODAY')
    return date.fromisoformat(d) if d else date.today()


def add_years(d, n):
    try:
        return d.replace(year=d.year + n)
    except ValueError:            # 29 February
        return d.replace(year=d.year + n, day=28)


def month_end(y, m):
    return date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)


def bands(r):
    """Anniversary bands: each month Jan-Mar, then Apr-Dec as one, then each month Jan-Jun next year."""
    b = [(date(r, m, 1), month_end(r, m)) for m in (1, 2, 3)] + [(date(r, 4, 1), date(r, 12, 31))]
    return b + [(date(r + 1, m, 1), month_end(r + 1, m)) for m in range(1, 7)]


def weeks(t, e_from, e_to):
    """Enrolled between e_from and e_to -> EFC's enrolledWeeksFrom (at least) / enrolledWeeksTo (at most), a little wide."""
    return max(0, math.floor((t - e_to).days / 7)), math.ceil((t - e_from).days / 7)


def query(t, loc, yrs, a_from, a_to, ages=None):
    wf, wt = weeks(t, add_years(a_from, -yrs), add_years(a_to, -yrs))
    p = {'location': loc, 'status': 'Enrolled', 'Order': 'Asc', 'OrderBy': 'Index', 'enrolledWeeksFrom': wf, 'enrolledWeeksTo': wt}
    if ages:
        p['ageFrom'], p['ageTo'] = ages
    return p


def key(p):
    return (p['location'], p['enrolledWeeksFrom'], p['enrolledWeeksTo'], p.get('ageFrom'), p.get('ageTo'))


def plan():
    t = today(); r = t.year
    os.makedirs(OUT, exist_ok=True)
    json.dump({'today': t.isoformat(), 'year': r}, open(os.path.join(OUT, 'plan.json'), 'w'))
    for loc in SCHOOLS:
        for y in YEARS:
            print(json.dumps(query(t, loc, y, date(r, 1, 1), date(r + 1, 6, 30))))


def saved():
    p = os.path.join(OUT, 'plan.json')
    if not os.path.exists(p):
        sys.exit('Run "plan" first.')
    s = json.load(open(p))
    return date.fromisoformat(s['today']), s['year']


def text_of(c):
    return c if isinstance(c, str) else ''.join(x.get('text', '') for x in (c or []) if isinstance(x, dict))


def runs():
    """(params, rows) for every Member Query this session ran with enrolledWeeksFrom/To."""
    logs = [os.environ['LSA_LOG']] if os.environ.get('LSA_LOG') else sorted(glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')), key=os.path.getmtime)
    if not logs:
        sys.exit('No session log found.')
    asked, out = {}, []
    for line in open(logs[-1], encoding='utf-8'):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        c = (o.get('message') or {}).get('content')
        if not isinstance(c, list):
            continue
        for b in c:
            if not isinstance(b, dict):
                continue
            if b.get('type') == 'tool_use':
                p = (b.get('input') or {}).get('params')
                if isinstance(p, str):
                    try:
                        p = json.loads(p)
                    except ValueError:
                        p = None
                if isinstance(p, dict) and 'enrolledWeeksFrom' in p and 'enrolledWeeksTo' in p and p.get('location'):
                    asked[b['id']] = p
            elif b.get('type') == 'tool_result' and b.get('tool_use_id') in asked:
                t = text_of(b.get('content')).strip()
                if not t.startswith('{'):                     # a big result saved to a file: read the file
                    m = re.search(r'(/\S*tool-results/\S+?\.(?:txt|json))', t)
                    try:
                        t = open(m.group(1), encoding='utf-8').read() if m else ''
                    except OSError:
                        t = ''
                try:
                    rows = json.loads(t).get('results')
                except (ValueError, AttributeError):
                    continue
                if isinstance(rows, list):
                    out.append((asked[b['tool_use_id']], rows))
    return out


def more():
    t, r = saved()
    done = runs()
    ran = {key(p) for p, _ in done}
    todo = []
    for p, rows in done:
        if not rows:
            continue
        ages = (p['ageFrom'], p['ageTo']) if 'ageFrom' in p else None
        # A whole-window query (one school and milestone) that found anyone: ask month band by month band
        whole = any(key(query(t, p['location'], y, date(r, 1, 1), date(r + 1, 6, 30))) == key(p) for y in YEARS)
        if whole and not ages:
            for y in YEARS:
                if key(query(t, p['location'], y, date(r, 1, 1), date(r + 1, 6, 30))) == key(p):
                    todo += [query(t, p['location'], y, a, b) for a, b in bands(r)]
        elif len(rows) >= PAGE and not ages:             # a band with a full page: ask again by age group
            todo += [dict(p, ageFrom=a, ageTo=b) for a, b in AGES]
        elif len(rows) >= PAGE:
            print(f'WARNING: {SCHOOLS.get(p["location"])} weeks {p["enrolledWeeksFrom"]}-{p["enrolledWeeksTo"]} ages {ages} still returned {PAGE}: some people may be missing.', file=sys.stderr)
    seen = set()
    for q in todo:
        k = key(q)
        if k not in ran and k not in seen:
            seen.add(k)
            print(json.dumps(q))


def collect():
    t, r = saved()
    people = {}
    for p, rows in runs():
        lo = t - timedelta(days=7 * p['enrolledWeeksTo'] + SLACK)
        hi = t - timedelta(days=7 * p['enrolledWeeksFrom'] - SLACK)
        for x in rows:
            m = (x or {}).get('member') or {}
            i = m.get('id')
            if not i or i.startswith(TEST_ACCOUNTS):
                continue
            ref = m.get('reference') or ''
            pre = re.match(r'^(AU-\d+)-', ref)
            name = ' '.join(filter(None, [(m.get('firstName') or '').strip(), (m.get('lastName') or '').strip()]))
            d = people.setdefault(i, {'id': i, 'ref': ref, 'name': name, 'loc': (PREFIX.get(pre.group(1)) if pre else None) or SCHOOLS.get(p['location']), 'ranges': []})
            d['ranges'].append((lo, hi))
    rows = []
    for d in people.values():
        lo, hi = max(a for a, _ in d['ranges']), min(b for _, b in d['ranges'])
        if lo > hi:                       # results don't agree (EFC rounding): use the widest
            lo, hi = min(a for a, _ in d['ranges']), max(b for _, b in d['ranges'])
        rows.append({'id': d['id'], 'ref': d['ref'], 'name': d['name'], 'loc': d['loc'], 'from': lo.isoformat(), 'to': hi.isoformat()})
    rows.sort(key=lambda x: (x['loc'] or '', x['name']))
    os.makedirs(OUT, exist_ok=True)
    body = json.dumps(rows, separators=(',', ':'), ensure_ascii=False)
    open(os.path.join(OUT, 'lsa.sql'), 'w', encoding='utf-8').write(f"select lsa_load($j${body}$j$::jsonb);")
    by = {}
    for x in rows:
        by[x['loc']] = by.get(x['loc'], 0) + 1
    print(f'{len(rows)} people in this year\'s window -> {os.path.join(OUT, "lsa.sql")}  ' + ', '.join(f'{k}: {v}' for k, v in sorted(by.items(), key=lambda z: str(z[0]))))


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] not in ('plan', 'more', 'collect'):
        sys.exit(__doc__)
    {'plan': plan, 'more': more, 'collect': collect}[a[0]]()
