// AMA Gradings: booking sheet.
// When a family pays for a grading or presses Book, the Gradings app adds a row to this sheet. A Zap
// (trigger: Google Sheets "New Spreadsheet Row", action: EFC Aquila "Book Session") then books the EFC session.
//
// One tab per location: each booking is written to a tab named after its school (Marrickville, Sydenham,
// Concord, West, Sylvania), created with headings the first time that school books. That lets you run one
// Zap per location, each with Book Session fixed to that school - so a 4.5 "Book Session" that needs the
// location set in the Zap works, and bookings never go to the wrong school.
//
// Set up (once):
// 1. Make a new Google Sheet (e.g. "AMA grading bookings"). Leave it empty: each location's tab (and its
//    headings) is created on that location's first booking.
// 2. Extensions > Apps Script. Delete what's there, paste this whole file, and put the key from
//    Gradings > Settings > Booking sheet between the quotes on the KEY line below. Save.
// 3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy, allow access,
//    and copy the Web app URL (https://script.google.com/macros/s/.../exec).
//    (Updating this script later: Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy,
//    so the same Web app URL serves the new code.)
// 4. Paste that URL into Gradings > Settings > Booking sheet, and Save.
// 5. In Zapier, set up one Zap PER LOCATION. Do a test booking for each school first so its tab exists, then:
//    trigger Google Sheets "New Spreadsheet Row" with Worksheet = that location's tab, action EFC Aquila
//    "Book Session": Location = location_id, Date = date, Member ID = member_id, Session = session_id. Turn it on.
//    (location_id is in the row too, so you can also map the Location field straight from it.)
// "Anyone" can reach the URL, but rows are only added with the right key, and the URL itself is long and private.

const KEY = 'PASTE-THE-KEY-FROM-GRADINGS-SETTINGS';
const COLUMNS = ['received_at', 'member_id', 'efc_ref', 'student', 'date', 'session_id', 'location_id', 'location', 'belt_to', 'programme', 'paid', 'paid_how'];

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'Not JSON' }); }
  if (!KEY || KEY.indexOf('PASTE') === 0 || d.key !== KEY) return reply({ ok: false, error: 'Wrong key' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tab = tabName(d.location);
    let sheet = ss.getSheetByName(tab);
    if (!sheet) {
      // First booking for this location: drop the blank default "Sheet1" if it's unused, then make the tab.
      const first = ss.getSheets()[0];
      if (ss.getSheets().length === 1 && first.getLastRow() === 0 && /^sheet1$/i.test(first.getName())) first.setName(tab);
      sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
    }
    if (sheet.getLastRow() === 0) sheet.appendRow(COLUMNS);
    d.received_at = new Date();
    d.paid = d.paid ? 'Yes' : 'No';
    sheet.appendRow(COLUMNS.map(c => (d[c] === undefined || d[c] === null) ? '' : d[c]));
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

// A safe, stable tab name from the location (sheet tab names can't contain : \ / ? * [ ] and cap at 100 chars).
function tabName(location) {
  const name = String(location == null ? '' : location).replace(/[:\\\/?*\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, 100) : 'Other';
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
