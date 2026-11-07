// @ts-nocheck
// AMA Toolkit: Google Drive upload for the service-award "memories" feature.
// Uploads a member's photos/videos into a per-person folder inside a Google Shared Drive.
//
// Auth: OAuth refresh token (no service-account key, so it works under the
// iam.disableServiceAccountKeyCreation org policy). The authorising Workspace user must be a
// member of the Shared Drive with Content Manager access.
//
// Deploy in Supabase, verify_jwt OFF (the upload page has no Supabase login; this function
// checks its own per-person upload token). Secrets needed (Project Settings > Edge Functions > Secrets):
//   GOOGLE_CLIENT_ID       the OAuth client id
//   GOOGLE_CLIENT_SECRET   the OAuth client secret
//   GOOGLE_REFRESH_TOKEN   the refresh token from the OAuth Playground (one-time)
//   SHARED_DRIVE_ID        the parent id from the folder's URL (drive/folders/<id>) - a Shared Drive or a normal folder
//
// Endpoints:
//   GET  ?test=1                              auth + folder + tiny upload, to prove the setup works
//   POST {person, filename, contentType}      ensure the person's folder, return a resumable upload URL
//                                             the browser then PUTs the file bytes straight to Drive
//
// TODO before going live: validate a per-person upload token (from the SMS link) in handleStart,
// so only invited members can upload, and the folder is chosen from the token, not the request body.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Service-role client, to read the per-person upload tokens (table lsa_memory_tokens).
const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);

function env(name) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
}

// Exchange the long-lived refresh token for a short-lived access token.
async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google auth failed: ' + (data.error_description || data.error || res.status));
  return data.access_token;
}

const driveArgs = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

// Find (or create) a folder of this name inside the parent. Returns its id.
// The parent can be a Shared Drive or a normal folder, so we search across all drives.
async function ensureFolder(token, name) {
  const parentId = env('SHARED_DRIVE_ID');
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false and '${parentId}' in parents`;
  const url = `${DRIVE}/files?corpora=allDrives&${driveArgs}&q=${encodeURIComponent(q)}&fields=files(id,name)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error('Drive search failed: ' + (data.error?.message || res.status));
  if (data.files && data.files.length) return data.files[0].id;

  const mk = await fetch(`${DRIVE}/files?${driveArgs}&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
  });
  const made = await mk.json();
  if (!mk.ok) throw new Error('Folder create failed: ' + (made.error?.message || mk.status));
  return made.id;
}

const cleanName = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

// Prove the whole chain works: auth, folder, upload.
async function handleTest() {
  const token = await accessToken();
  const folderId = await ensureFolder(token, 'AMA setup test');
  const boundary = 'ama' + crypto.randomUUID();
  const meta = { name: `setup-check-${new Date().toISOString().slice(0, 19)}.txt`, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\nGoogle Drive is connected to the AMA Toolkit.\r\n--${boundary}--`;
  const up = await fetch(`${UPLOAD}/files?uploadType=multipart&${driveArgs}&fields=id,webViewLink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const made = await up.json();
  if (!up.ok) throw new Error('Test upload failed: ' + (made.error?.message || up.status));
  return json({ ok: true, folderId, fileId: made.id, link: made.webViewLink, message: 'Drive is connected. Check the "AMA setup test" folder in the Shared Drive.' });
}

// Look up an upload token (from the SMS link) and return who it's for, so the page can greet them.
async function handleWho(tokenStr) {
  if (!tokenStr) return fail('Missing link code.', 400);
  const { data: row } = await db.from('lsa_memory_tokens').select('person_name, years').eq('token', tokenStr).maybeSingle();
  if (!row) return fail('This upload link is not valid or has expired.', 404);
  return json({ person_name: row.person_name, years: row.years });
}

// Real flow: validate the token, make sure the person's folder exists, and hand back a resumable
// upload URL the browser uploads the file to directly (keeps large media out of this function).
async function handleStart(req) {
  const b = await req.json().catch(() => ({}));
  // The browser uploads straight to Google's resumable URL. Google only returns CORS headers on that
  // upload if the session was started with the page's Origin, so pass it through — otherwise the upload
  // succeeds but the browser can't read the response and wrongly shows it as failed.
  const origin = req.headers.get('origin') || 'https://app.train-ama.com';
  const tokenStr = String(b.token || '').trim();
  if (!tokenStr) return fail('This upload link is missing its code.', 403);
  const { data: row, error } = await db.from('lsa_memory_tokens').select('person_name, years, upload_count').eq('token', tokenStr).maybeSingle();
  if (error) throw new Error('Link check failed: ' + error.message);
  if (!row) return fail('This upload link is not valid or has expired.', 403);

  const filename = cleanName(b.filename) || 'upload';
  const contentType = String(b.contentType || 'application/octet-stream');
  const person = cleanName(`${row.person_name} - ${row.years} years`);

  const token = await accessToken();
  const folderId = await ensureFolder(token, person);
  const init = await fetch(`${UPLOAD}/files?uploadType=resumable&${driveArgs}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      Origin: origin
    },
    body: JSON.stringify({ name: filename, parents: [folderId] })
  });
  if (!init.ok) {
    const e = await init.json().catch(() => ({}));
    throw new Error('Could not start upload: ' + (e.error?.message || init.status));
  }
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new Error('Drive did not return an upload URL');
  db.from('lsa_memory_tokens').update({ last_upload_at: new Date().toISOString(), upload_count: (row.upload_count || 0) + 1 }).eq('token', tokenStr).then(() => {}, () => {});
  return json({ ok: true, folderId, uploadUrl });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.searchParams.get('test')) return await handleTest();
    if (req.method === 'GET' && url.searchParams.get('who')) return await handleWho(url.searchParams.get('who'));
    if (req.method === 'POST') return await handleStart(req);
    return fail('Use GET ?who=<token>, GET ?test=1, or POST {token, filename, contentType}.', 405);
  } catch (e) {
    console.error(e);
    return fail(String(e && e.message || e), 500);
  }
});
