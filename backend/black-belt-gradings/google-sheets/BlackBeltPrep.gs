/**
 * WORK IN PROGRESS: not finished or tested yet. Do not install until this line is removed.
 *
 * Black Belt Prep: Google Sheets report
 *
 * Copies the latest Black Belt Prep information into this Google Sheet and keeps it up to date.
 * Setup steps are in google-sheets/README.md. In short:
 *   1. Extensions > Apps Script, paste this whole file in, Save.
 *   2. Reload the sheet. Use the "Black Belt Prep" menu > "Connect" and sign in with the report login.
 *   3. "Turn on automatic updates" (every 15 minutes), or "Update now" whenever you like.
 *
 * The tabs this script writes are rewritten each time; don't type in them. Your own tabs are left alone.
 */

// The Black Belt Prep / AMA ID Cards Supabase project (the same values as the app's config.js)
var SUPABASE_URL = 'https://ptdrcxngaptcgswfbjhg.supabase.co';
var SUPABASE_KEY = 'sb_publishable_YsRY6SlgR7U_ohn_xxQD1A_lrowkIGS';
var UPDATE_EVERY_MINUTES = 15;

var TABS = ['Summary', 'Students', 'Attendance', 'Attendance history', 'Readiness', 'Grading', 'Certificates', 'Payments', 'Follow-up', 'ID cards'];

var LABEL = {
  present: 'Present', absent: 'Absent', excused: 'Excused', not_recorded: 'Not recorded',
  planned: 'Planned', active: 'Active', completed: 'Completed', archived: 'Archived',
  not_assessed: 'Not yet assessed', on_track: 'On track', needs_preparation: 'Needs more preparation',
  not_ready: 'Not ready for grading', ready: 'Ready for grading', awaiting_review: 'Awaiting instructor review',
  not_invoiced: 'Nothing owed yet', due: 'Payment due', partially_paid: 'Partially paid', paid: 'Paid',
  overdue: 'Payment overdue', waived: 'Waived', refund_pending: 'Refund pending', refunded: 'Refunded',
  awaiting_result: 'Awaiting grading result', awaiting_approval: 'Awaiting approval', details_check: 'Details to be checked',
  approved: 'Approved for issue', ready_for_production: 'Ready for production', printed: 'Printed', issued: 'Issued',
  reprint_required: 'Reprint required', not_required: 'Not required', nominated: 'Put forward', passed: 'Passed',
  unsuccessful: 'Unsuccessful', deferred: 'Deferred', eligible: 'Eligible', not_eligible: 'Not eligible', pending: 'Awaiting decision'
};
var REASONS = { technique: 'Technique requires improvement', fitness: 'Fitness or conditioning', attendance: 'Attendance concerns',
  more_practice: 'Additional practice required', instructor_recommendation: 'Instructor recommendation', other: 'Other' };
var BELTS = ['Cho Dan Bo', 'Probationary Black Belt', '1st Dan Black Belt', '1st Dan Level 1', '2nd Dan', '2nd Dan Level 1', '2nd Dan Level 2',
  '3rd Dan', '3rd Dan Level 1', '3rd Dan Level 2', '3rd Dan Level 3', '4th Dan', '4th Dan Level 1', '4th Dan Level 2', '4th Dan Level 3', '4th Dan Level 4',
  '5th Dan', '5th Dan Level 1', '5th Dan Level 2', '5th Dan Level 3', '5th Dan Level 4', '5th Dan Level 5', '6th Dan', '7th Dan', '8th Dan', '9th Dan'];
var DAN_TARGET = { 'Cho Dan Bo': 'Probationary Black Belt', 'Probationary Black Belt': '1st Dan Black Belt', '1st Dan Level 1': '2nd Dan',
  '2nd Dan Level 2': '3rd Dan', '3rd Dan Level 3': '4th Dan', '4th Dan Level 4': '5th Dan', '5th Dan Level 5': '6th Dan',
  '6th Dan': '7th Dan', '7th Dan': '8th Dan', '8th Dan': '9th Dan' };
var OWING = ['due', 'partially_paid', 'overdue'];

/* ---------------------------------------------------------------- Menu ---------------------------------------------------------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Black Belt Prep')
    .addItem('Update now', 'updateNow')
    .addSeparator()
    .addItem('Connect (sign in)', 'connect')
    .addItem('Turn on automatic updates', 'turnOnAutomaticUpdates')
    .addItem('Turn off automatic updates', 'turnOffAutomaticUpdates')
    .addToUi();
}

function connect() {
  var ui = SpreadsheetApp.getUi();
  var email = ui.prompt('Connect to Black Belt Prep', 'Email of the report login (see the setup guide):', ui.ButtonSet.OK_CANCEL);
  if (email.getSelectedButton() !== ui.Button.OK) return;
  var pw = ui.prompt('Connect to Black Belt Prep', 'Password for ' + email.getResponseText().trim() + ':', ui.ButtonSet.OK_CANCEL);
  if (pw.getSelectedButton() !== ui.Button.OK) return;
  var props = PropertiesService.getUserProperties();
  props.setProperties({ BBP_EMAIL: email.getResponseText().trim(), BBP_PASSWORD: pw.getResponseText() });
  try {
    updateSheet_();
    ui.alert('Connected', 'The sheet has been updated. Use "Turn on automatic updates" to keep it up to date.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Could not connect', String(e.message || e), ui.ButtonSet.OK);
  }
}

function updateNow() {
  try { updateSheet_(); SpreadsheetApp.getActive().toast('Black Belt Prep data updated.'); }
  catch (e) { SpreadsheetApp.getUi().alert('Update failed', String(e.message || e), SpreadsheetApp.getUi().ButtonSet.OK); }
}

function turnOnAutomaticUpdates() {
  turnOffAutomaticUpdates(true);
  ScriptApp.newTrigger('scheduledUpdate').timeBased().everyMinutes(UPDATE_EVERY_MINUTES).create();
  updateNow();
  SpreadsheetApp.getActive().toast('Automatic updates are on (every ' + UPDATE_EVERY_MINUTES + ' minutes).');
}

function turnOffAutomaticUpdates(quiet) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scheduledUpdate') ScriptApp.deleteTrigger(t); });
  if (quiet !== true) SpreadsheetApp.getActive().toast('Automatic updates are off.');
}

// Runs on the timer. Errors are written to the Summary tab rather than popping up.
function scheduledUpdate() {
  try { updateSheet_(); }
  catch (e) {
    var sh = SpreadsheetApp.getActive().getSheetByName('Summary');
    if (sh) sh.getRange(2, 1, 1, 2).setValues([['Last update failed', new Date() + ': ' + (e.message || e)]]);
  }
}

/* ---------------------------------------------------------------- Supabase ---------------------------------------------------------------- */

function signIn_() {
  var props = PropertiesService.getUserProperties();
  var email = props.getProperty('BBP_EMAIL'), password = props.getProperty('BBP_PASSWORD');
  if (!email || !password) throw new Error('Not connected yet. Use Black Belt Prep > Connect.');
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: SUPABASE_KEY }, payload: JSON.stringify({ email: email, password: password })
  });
  if (res.getResponseCode() !== 200) throw new Error('Sign-in failed. Check the email and password (Black Belt Prep > Connect).');
  return JSON.parse(res.getContentText()).access_token;
}

function api_(token, path, body) {
  var opts = { method: body ? 'post' : 'get', muteHttpExceptions: true, headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  if (res.getResponseCode() >= 300) {
    var msg = res.getContentText();
    try { msg = JSON.parse(msg).message || msg; } catch (e) {}
    throw new Error('Could not read ' + path.split('?')[0] + ': ' + msg);
  }
  return JSON.parse(res.getContentText() || '[]');
}

// Reads everything the report login is allowed to see
function load_(token) {
  var tryGet = function (path, body) { try { return api_(token, path, body); } catch (e) { return []; } };
  var roles = api_(token, 'rpc/prep_my_roles', {});
  if (!roles || !roles.length) throw new Error('This login has no role in Black Belt Prep. Add it under More > Users in the app (Viewer, plus Payments to include fees).');
  return {
    roles: roles,
    students: api_(token, 'prep_students?select=*&order=full_name'),
    cycles: api_(token, 'prep_cycles?select=*&order=created_at.desc'),
    sessions: api_(token, 'prep_sessions?select=*&order=session_number'),
    enrolments: api_(token, 'prep_enrolments?select=*'),
    attendance: api_(token, 'prep_attendance?select=*'),
    summary: api_(token, 'prep_attendance_summary?select=*'),
    readiness: api_(token, 'prep_readiness?select=*'),
    grading: api_(token, 'prep_grading?select=*&order=created_at.desc'),
    certificates: api_(token, 'prep_certificates?select=*&order=created_at.desc'),
    payments: tryGet('prep_payment_summary?select=*'),
    dans: tryGet('prep_dan_numbers?select=*'),
    cards: tryGet('rpc/prep_card_people', {})
  };
}

/* ---------------------------------------------------------------- Building the tabs ---------------------------------------------------------------- */

function updateSheet_() {
  var d = load_(signIn_());
  var tabs = buildTabs_(d, new Date());
  var ss = SpreadsheetApp.getActive();
  TABS.forEach(function (name, i) {
    var t = tabs[name]; if (!t) return;
    var sh = ss.getSheetByName(name) || ss.insertSheet(name, i);
    writeTab_(sh, t);
  });
}

function writeTab_(sh, t) {
  sh.clear();
  var rows = [].concat(t.top || [], [t.head], t.rows);
  var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  rows = rows.map(function (r) { var x = r.slice(); while (x.length < width) x.push(''); return x; });
  sh.getRange(1, 1, rows.length, width).setValues(rows);
  var headRow = (t.top || []).length + 1;
  sh.getRange(headRow, 1, 1, width).setFontWeight('bold').setBackground('#e3f2ea');
  if (t.top && t.top.length) sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sh.setFrozenRows(headRow);
  sh.autoResizeColumns(1, width);
}

function label_(v) { return v == null ? '' : (LABEL[v] || v); }
function money_(n) { return n == null || n === '' ? '' : Number(n); }
function day_(iso) { return iso ? String(iso).slice(0, 10) : ''; }
function nextBelt_(b) { var i = BELTS.indexOf(b); return i >= 0 && i < BELTS.length - 1 ? BELTS[i + 1] : ''; }

function buildTabs_(d, now) {
  var byId = {}; d.students.forEach(function (s) { byId[s.student_id] = s; });
  var cyc = {}; d.cycles.forEach(function (c) { cyc[c.cycle_id] = c; });
  var key = function (c, s) { return c + '|' + s; };
  var sum = {}; d.summary.forEach(function (x) { sum[key(x.cycle_id, x.student_id)] = x; });
  var rd = {}; d.readiness.forEach(function (x) { rd[key(x.cycle_id, x.student_id)] = x; });
  var gr = {}; d.grading.forEach(function (x) { var k = key(x.cycle_id, x.student_id); if (!gr[k]) gr[k] = x; });
  var cert = {}; d.certificates.forEach(function (x) { if (x.grading_id && !cert[x.grading_id]) cert[x.grading_id] = x; });
  var att = {}; d.attendance.forEach(function (x) { att[key(x.session_id, x.student_id)] = x.status; });
  var enr = {}; d.enrolments.forEach(function (e) { (enr[e.cycle_id] = enr[e.cycle_id] || []).push(e); });
  var card = {}; d.cards.forEach(function (c) { if (c.student_id) card[c.student_id] = c; });
  var dan = function (s) { var t = DAN_TARGET[s.belt_rank]; if (!t) return ''; var x = d.dans.filter(function (n) { return n.student_id === s.student_id && n.target_rank === t; })[0]; return x ? x.dan_number : ''; };
  var getsCard = function (s) { var t = DAN_TARGET[s.belt_rank]; return !!t && t !== 'Probationary Black Belt'; };
  var cardText = function (s) {
    if (!getsCard(s)) return '';
    var c = card[s.student_id]; if (!c) return 'No card linked';
    if (c.queue_status) return 'Card in print queue';
    if (c.printed_at) return 'ID card printed';
    if (c.times_printed > 0) return 'Card reprint needed';
    return 'Card not printed yet';
  };
  var sessionsOf = function (cid) { return d.sessions.filter(function (x) { return x.cycle_id === cid; }).sort(function (a, b) { return a.session_number - b.session_number; }); };
  var studentsIn = function (cid) { return (enr[cid] || []).map(function (e) { return byId[e.student_id]; }).filter(Boolean).sort(function (a, b) { return a.full_name.localeCompare(b.full_name); }); };
  var active = d.cycles.filter(function (c) { return c.status === 'active'; })[0] || d.cycles[0] || null;
  var money = d.payments.length > 0 || d.roles.indexOf('payments') >= 0 || d.roles.indexOf('admin') >= 0;
  var stamp = 'Updated ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'd MMM yyyy, h:mm a');
  var top = function (title) { return [[title + (active ? ' · ' + active.name : '')], [stamp], []]; };
  var tabs = {};

  // Students
  tabs['Students'] = { top: [['Student register'], [stamp], []],
    head: ['Student ID', 'Full name', 'Certificate name', 'Belt', 'Next belt', 'Dan number', 'ID card', 'Active', 'Date added', 'Notes'],
    rows: d.students.filter(function (s) { return !s.is_test; }).map(function (s) {
      return [s.student_id, s.full_name, s.certificate_name || '', s.belt_rank || '', nextBelt_(s.belt_rank), dan(s), cardText(s), s.is_active ? 'Yes' : 'No', day_(s.date_added), s.notes || ''];
    }) };

  // Attendance (active cycle)
  var aSess = active ? sessionsOf(active.cycle_id) : [];
  tabs['Attendance'] = { top: top('Attendance'),
    head: ['Student ID', 'Name', 'Belt'].concat(aSess.map(function (x, i) { return (i === aSess.length - 1 ? 'Sign-off ' : 'Session ' + x.session_number + ' ') + day_(x.session_date); }))
      .concat(['Attended', 'Absent', 'Excused', 'Attendance %', 'Requirement met', 'ID card']),
    rows: active ? studentsIn(active.cycle_id).map(function (s) {
      var m = sum[key(active.cycle_id, s.student_id)] || {};
      return [s.student_id, s.full_name, s.belt_rank || ''].concat(aSess.map(function (x) { return ({ present: 'P', absent: 'A', excused: 'E' })[att[key(x.session_id, s.student_id)]] || ''; }))
        .concat([m.attended || 0, m.absences || 0, m.excused || 0, m.attendance_pct == null ? '' : Number(m.attendance_pct) / 100, m.attendance_eligible ? 'Yes' : 'No', cardText(s)]);
    }) : [] };

  // Attendance history (every cycle)
  var hist = [];
  d.cycles.forEach(function (c) {
    var n = sessionsOf(c.cycle_id).length;
    studentsIn(c.cycle_id).forEach(function (s) {
      var m = sum[key(c.cycle_id, s.student_id)] || {}, g = gr[key(c.cycle_id, s.student_id)];
      hist.push([s.student_id, s.full_name, c.name, label_(c.status), (m.attended || 0) + '/' + n, m.attendance_pct == null ? '' : Number(m.attendance_pct) / 100,
        label_(m.signoff_status || 'not_recorded'), m.attendance_eligible ? 'Yes' : 'No', label_((rd[key(c.cycle_id, s.student_id)] || {}).status || 'not_assessed'), g && g.result ? label_(g.result) : '']);
    });
  });
  tabs['Attendance history'] = { top: [['Attendance history'], [stamp], []],
    head: ['Student ID', 'Name', 'Cycle', 'Cycle status', 'Attended', 'Attendance %', 'Sign-off', 'Requirement met', 'Readiness', 'Grading result'], rows: hist };

  // Readiness (active cycle)
  tabs['Readiness'] = { top: top('Readiness'),
    head: ['Student ID', 'Name', 'Belt', 'Readiness', 'Reason', 'Instructor notes', 'Next action', 'Last reviewed', 'Reviewed by'],
    rows: active ? studentsIn(active.cycle_id).map(function (s) {
      var r = rd[key(active.cycle_id, s.student_id)] || {};
      return [s.student_id, s.full_name, s.belt_rank || '', label_(r.status || 'not_assessed'), REASONS[r.reason] || '', r.notes || '', r.next_action || '', day_(r.reviewed_at), r.reviewed_by || ''];
    }) : [] };

  // Grading (active cycle)
  var isGrading = {}; d.enrolments.forEach(function (e) { if (e.is_grading) isGrading[key(e.cycle_id, e.student_id)] = true; });
  tabs['Grading'] = { top: active ? [['Grading · ' + active.name + (active.grading_date ? ' · grading ' + day_(active.grading_date) : '')], [stamp], []] : top('Grading'),
    head: ['Student ID', 'Name', 'Current belt', 'Grading to', 'Dan number', 'Attendance requirement met', 'Readiness', 'Eligibility', 'Decision reason', 'Put forward', 'Result'],
    rows: active ? studentsIn(active.cycle_id).map(function (s) {
      var k = key(active.cycle_id, s.student_id), g = gr[k], m = sum[k] || {};
      return [s.student_id, s.full_name, s.belt_rank || '', (g && g.target_rank) || nextBelt_(s.belt_rank), dan(s), m.attendance_eligible ? 'Yes' : 'No',
        label_((rd[k] || {}).status || 'not_assessed'), g ? label_(g.eligibility_decision) : 'Awaiting decision', g ? g.decision_reason || '' : '', isGrading[k] ? 'Yes' : 'No', g && g.result ? label_(g.result) : ''];
    }) : [] };

  // Certificates (everyone with a grading record)
  tabs['Certificates'] = { top: [['Certificates'], [stamp], []],
    head: ['Cycle', 'Student ID', 'Name on certificate', 'Type', 'Awarded rank', 'Certificate number', 'Grading result', 'Status', 'Issue date', 'Notes'],
    rows: d.grading.filter(function (g) { return g.result || isGrading[key(g.cycle_id, g.student_id)]; }).map(function (g) {
      var s = byId[g.student_id] || {}, c = cert[g.grading_id];
      var st = c ? c.status : g.result === 'passed' ? 'awaiting_approval' : g.result ? 'not_required' : 'awaiting_result';
      return [(cyc[g.cycle_id] || {}).name || '', g.student_id, c ? c.certificate_name : (s.certificate_name || s.full_name || ''), c ? c.certificate_type : '',
        c ? c.awarded_rank || '' : g.target_rank || '', c ? c.certificate_number || '' : '', g.result ? label_(g.result) : '', label_(st), c ? day_(c.issue_date) : '', c ? c.notes || '' : ''];
    }) };

  // Payments (only when the report login can see money)
  tabs['Payments'] = money ? { top: top('Payments'),
    head: ['Cycle', 'Student ID', 'Name', 'Fee', 'Fee option', 'Amount due', 'Paid', 'Balance', 'Status', 'Due date', 'Notes'],
    rows: d.payments.slice().sort(function (a, b) { return ((byId[a.student_id] || {}).full_name || '').localeCompare((byId[b.student_id] || {}).full_name || ''); })
      .filter(function (p) { return !active || p.cycle_id === active.cycle_id; }).map(function (p) {
        return [(cyc[p.cycle_id] || {}).name || '', p.student_id, (byId[p.student_id] || {}).full_name || '', p.kind === 'grading' ? 'Grading to ' + p.target_rank : 'Session fees',
          p.kind === 'grading' ? '' : p.fee_override != null ? 'One-off fee' : p.payment_plan === 'upfront' ? 'Upfront' : 'Per session',
          money_(p.amount_due), money_(p.amount_paid), money_(p.balance), label_(p.status), day_(p.due_date), p.notes || ''];
      }) }
    : { top: [['Payments'], ['Fees are not included because the report login does not have the Payments role.'], []], head: [''], rows: [] };

  // Follow-up (active cycle)
  var today = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var past = {}; aSess.forEach(function (x) { if (x.session_date && x.session_date <= today) past[x.session_id] = true; });
  var follow = [];
  if (active) studentsIn(active.cycle_id).forEach(function (s) {
    var k = key(active.cycle_id, s.student_id), r = rd[k] || {}, m = sum[k] || {}, issues = [];
    if (r.status === 'not_ready' || r.status === 'needs_preparation') issues.push(label_(r.status) + (r.reason ? ' (' + REASONS[r.reason].toLowerCase() + ')' : ''));
    if (r.status === 'awaiting_review') issues.push('Awaiting instructor review');
    if (m.signoff_status === 'absent' || m.signoff_status === 'excused') issues.push('Missed the sign-off');
    var missing = aSess.filter(function (x) { return past[x.session_id] && (att[key(x.session_id, s.student_id)] || 'not_recorded') === 'not_recorded'; }).length;
    if (missing) issues.push(missing + ' past session' + (missing > 1 ? 's' : '') + ' not recorded');
    if (m.absences) issues.push(m.absences + ' absence' + (m.absences > 1 ? 's' : ''));
    var owing = 0;
    d.payments.filter(function (p) { return p.cycle_id === active.cycle_id && p.student_id === s.student_id && OWING.indexOf(p.status) >= 0; }).forEach(function (p) {
      issues.push((p.kind === 'grading' ? 'Grading fee ' : 'Session fees ') + (p.status === 'overdue' ? 'overdue' : 'owing')); owing += Number(p.balance);
    });
    if (issues.length) follow.push([s.student_id, s.full_name, s.belt_rank || '', issues.join('; '), r.next_action || ''].concat(money ? [owing || ''] : []));
  });
  tabs['Follow-up'] = { top: top('Follow-up'), head: ['Student ID', 'Name', 'Belt', 'Issues', 'Next action'].concat(money ? ['Owing'] : []), rows: follow };

  // ID cards (students going for 1st Dan or higher)
  tabs['ID cards'] = { top: [['ID cards'], [stamp], []],
    head: ['Student ID', 'Name', 'Belt', 'Dan number', 'Card status', 'Printed on', 'Name on card'],
    rows: d.students.filter(function (s) { return s.is_active && !s.is_test && getsCard(s); }).map(function (s) {
      var c = card[s.student_id] || {};
      return [s.student_id, s.full_name, s.belt_rank || '', dan(s), cardText(s), day_(c.printed_at), c.name || ''];
    }) };

  // Summary
  var inCycle = active ? studentsIn(active.cycle_id) : [];
  var count = function (f) { return inCycle.filter(f).length; };
  var rdOf = function (s) { return (rd[key(active.cycle_id, s.student_id)] || {}).status || 'not_assessed'; };
  var owingTotal = 0; d.payments.forEach(function (p) { if (active && p.cycle_id === active.cycle_id && OWING.indexOf(p.status) >= 0) owingTotal += Number(p.balance); });
  var lines = active ? [
    ['Active cycle', active.name],
    ['Sessions', aSess.map(function (x, i) { return (i === aSess.length - 1 ? 'Sign-off ' : 'S' + x.session_number + ' ') + day_(x.session_date); }).join(', ')],
    ['Grading date', day_(active.grading_date)],
    ['Students in cycle', inCycle.length],
    ['Attendance requirement met', count(function (s) { return (sum[key(active.cycle_id, s.student_id)] || {}).attendance_eligible; })],
    ['Missed the sign-off', count(function (s) { var x = (sum[key(active.cycle_id, s.student_id)] || {}).signoff_status; return x === 'absent' || x === 'excused'; })],
    ['Ready for grading', count(function (s) { return rdOf(s) === 'ready'; })],
    ['Needs more preparation', count(function (s) { return rdOf(s) === 'needs_preparation'; })],
    ['Not ready for grading', count(function (s) { return rdOf(s) === 'not_ready'; })],
    ['Awaiting assessment or review', count(function (s) { return rdOf(s) === 'not_assessed' || rdOf(s) === 'awaiting_review'; })],
    ['Put forward for grading', count(function (s) { return isGrading[key(active.cycle_id, s.student_id)]; })],
    ['Passed', count(function (s) { var g = gr[key(active.cycle_id, s.student_id)]; return g && g.result === 'passed'; })],
    ['Going for 1st Dan+ without an ID card printed', count(function (s) { return getsCard(s) && cardText(s) !== 'ID card printed'; })]
  ].concat(money ? [['Outstanding fees', owingTotal]] : []) : [['Active cycle', 'None']];
  tabs['Summary'] = { top: [['Black Belt Prep'], [stamp], []], head: ['', ''], rows: lines };
  tabs['Summary'].head = ['Item', 'Value'];
  return tabs;
}
