/**
 * EHIFFECT BOOKING BACKEND
 * ========================
 * This one file powers three things:
 *   1. The booking website  (saves bookings, looks up clients)
 *   2. The "Bookings" sheet (your raw list of every request)
 *   3. Auto-updating tabs: "Dashboard", "Clients", "Kits", and "Denied & Rescheduled"
 *
 * SETUP (first time, or after pasting an update)
 *   1. Extensions → Apps Script → delete everything → paste this whole file → Save.
 *   2. Pick "formatSheet" in the function dropdown at the top → Run → approve permissions
 *      (it also turns on approval emails when you change a Status in the sheet).
 *   3. Deploy → Manage deployments → pencil icon → Version: New version → Deploy.
 *      (Editing the existing deployment keeps your website URL the same.)
 *   After that, a menu called "Ehiffect" appears in your sheet with a Refresh button.
 *
 * HOW YOUR SHEET WORKS
 *   • Dashboard = your daily view. Stat tiles on top, then "Open a booking": pick any client from
 *     the dropdown (newest first) and see exactly what they booked — hairstyle, date and time, deals
 *     applied, deposit status — plus a GRAND TOTAL (booking total after deals, minus the deposit
 *     once paid). Denied / rescheduled / cancelled bookings show a coloured banner there. Below that:
 *     the newest 15 bookings, requests needing a reply (oldest first, with a ready-to-send text),
 *     the next 7 days, then tables that only appear when they have something in them (awaiting
 *     deposit, refunds owed, bundle pickups), deal usage, weekly revenue (hidden until you pick
 *     "Show"), and a row of charts at the bottom. Warnings marked ⚠ come from checks the sheet
 *     runs for you: double-bookings, a partner who hasn't booked, a no-show client rebooking,
 *     one-time deals reused. Updates by itself.
 *   • Denied & Rescheduled = every booking that did not go ahead as booked, with what is left to do
 *     about its deposit. Their date opens up again on the website automatically.
 *   • Tick "Deposit" on a booking once you've seen the Cash App payment. Change the numbers
 *     you care about at the top (deposit amount, response hours, gap between appointments).
 *   • Clients   = one row per person: visits, deals they've used, loyalty countdown.
 *   • Kits      = every pending/approved booking's care-kit status in one place — tick "Kit
 *     packed" in the Bookings tab once you've prepped one; unpacked kits stay pinned to the
 *     top of this tab so you always know what to work on next.
 *   • Bookings  = every request. Change the Status dropdown and the other tabs refresh.
 *   • Columns are found by their header NAME, so bookings always land under the right
 *     header. ("total" may also be titled "pricing".) Columns you add yourself are left alone.
 *   • formatSheet also tidies the Bookings tab: most-used columns on the left, technical
 *     ones hidden, partner/kit details in a [+] group, phones shown as 260-298-2022, and it
 *     repairs any old rows that ended up under the wrong headers. Safe to run any time.
 *
 * NOTE: everything goes through doGet (not doPost) because browsers turn POST into GET when
 * following Apps Script's redirect, so POST from a GitHub Pages site never reliably arrives.
 */


/* ================================================================
   1. SETTINGS — the only part you'll normally want to edit
   ================================================================ */

const NOTIFY_EMAIL = "ehivoltk@gmail.com";           // where new-booking emails go
const PHOTO_FOLDER_NAME = "Ehiffect Booking Photos";  // Drive folder for reference photos

// GOOGLE CALENDAR: every APPROVED booking becomes a calendar event (moved if you change the date/time,
// removed if it's denied / rescheduled / cancelled). Leave CALENDAR_ID blank to use the calendar of the
// Google account that owns this sheet. To use your OTHER Google account instead, put its email here AND
// share that account's calendar with this account ("Make changes to events") — steps are in the chat.
const CALENDAR_SYNC = true;
const CALENDAR_ID = "";
const CALENDAR_HOURS = 3;                             // how long a styling appointment blocks on the calendar

// Every Nth approved visit gets flagged for a surprise loyalty gift.
const LOYALTY_SURPRISE_EVERY = 5;

// Every deal on the website: key -> name shown in your sheet.
const DEAL_NAMES = {
  btc: "Back to Campus",
  hallohair: "Hallohair",
  campuscutie: "Campus Cutie",
  loyalty: "Loyalty Love",
  flash: "Flash Deal"
};

// Deals a client should only use ONCE. If someone books with one of these again,
// the booking gets a "Deal alert" (sheet, email, and website dashboard).
// Add or remove keys from the list above to change which deals count.
const ONE_TIME_DEALS = ["btc", "hallohair"];

const VALID_STATUSES = ["pending", "approved", "denied", "rescheduled", "no-show", "cancelled"];

// Used in the ready-to-send text messages.
const CASHTAG = "$ehiixs";

// Must exactly match CONFIG.adminPasscode in index.html. Without this check, anyone who found
// your Apps Script URL (visible in the site's network requests) could pull your whole client
// list or approve/deny/mark-paid bookings with no login at all — this is what actually blocks that.
const ADMIN_KEY = "ehiffect26";

// These three are just the starting defaults — once the sheet exists, edit them from the
// "Settings" row on the Dashboard tab instead (row 9) and they'll stick; no need to touch code.
const DEPOSIT_AMOUNT = 20;               // You promise clients a reply within this many hours; older pending requests show as overdue.
const RESPONSE_HOURS = 24;
const MIN_GAP_MINUTES = 120;             // Two appointments on the same day closer together than this get a scheduling warning.

// Reads the live values (Dashboard row 9 overrides, once set) so booking creation, checks,
// texts, and the Dashboard all agree on the same numbers even if the Dashboard hasn't been open.
function getSettings(){
  const p = PropertiesService.getScriptProperties();
  const num = (key, fallback) => { const v = Number(p.getProperty(key)); return v > 0 ? v : fallback; };
  return {
    depositAmount: num("depositAmount", DEPOSIT_AMOUNT),
    responseHours: num("responseHours", RESPONSE_HOURS),
    minGapMinutes: num("minGapMinutes", MIN_GAP_MINUTES)
  };
}

function saveSetting(key, value){
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

// Bookings tab layout: formatSheet puts the columns you use most on the left and the
// technical ones on the right (hidden). Set to false to keep your own column order.
const REORDER_COLUMNS = true;
const DISPLAY_ORDER = [
  "id", "name", "phone", "ig", "email", "date", "time", "status", "depositPaid", "depositRefunded", "serviceLabel", "total", "amountPaid", "grandTotal", "dealsUsed",
  "giftKit", "careKitCost", "kitComp", "kitPacked", "shipped", "serviced", "servicedOn", "dealAlert", "checks", "notes", "submittedAt", "photoUrls",
  "bookingType", "partnerName", "partnerContact", "visitCount", "loyaltyFlag", "dealKeys", "approvalEmailed"
];

// Brand colors used to style the sheet.
const COLORS = {
  pink: "#B85C82", blush: "#F4E1EA", cream: "#F8F3EF", ink: "#171214", muted: "#8C7B7E",
  alertBg: "#F6D9D9", alertText: "#7A2F2F", green: "#DDEBD9", gold: "#F3E4BF", grey: "#ECE7E4"
};


/* ================================================================
   2. COLUMNS — find each column by header name (not position)
   ================================================================ */

// Every field this script reads/writes. Order only matters for a brand-new sheet;
// any field missing from your sheet is added on the far right automatically.
const HEADERS = [
  "id", "name", "phone", "ig", "email", "date", "time", "notes", "serviceLabel", "total", "status",
  "submittedAt", "photoUrls", "dealsUsed", "bookingType", "partnerName", "partnerContact",
  "giftKit", "careKitCost", "kitComp", "kitPacked", "visitCount", "loyaltyFlag", "dealKeys", "dealAlert",
  "depositPaid", "depositRefunded", "checks", "approvalEmailed", "shipped", "serviced", "servicedOn", "amountPaid", "grandTotal", "lastEmail", "calendarEvent", "calendarEvent"
];

// Other header names that mean the same thing (ignores case, spaces, punctuation).
const HEADER_ALIASES = {
  total: ["pricing", "price"],
  serviceLabel: ["service"],
  photoUrls: ["photos"],
  dealsUsed: ["deals"]
};

function normHeader(s){ return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

function getSheet(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Bookings");
  if(!sheet){
    sheet = ss.insertSheet("Bookings");
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Returns { map: field -> 0-based column index, width: columns in use }.
function getColumns(sheet){
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(normHeader);
  const map = {};
  let width = lastCol;
  HEADERS.forEach(field => {
    const names = [normHeader(field)].concat((HEADER_ALIASES[field] || []).map(normHeader));
    let idx = headers.findIndex(h => names.indexOf(h) !== -1);
    if(idx === -1){                       // missing → add it on the right, never overwrite
      width += 1;
      sheet.getRange(1, width).setValue(field);
      headers[width - 1] = normHeader(field);
      idx = width - 1;
    }
    map[field] = idx;
  });
  return { map: map, width: Math.max(width, headers.length) };
}

function colLetter(n){
  let s = "";
  while(n > 0){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Every booking as a simple object, e.g. b.name, b.status, b.dealKeys. b.row = sheet row number.
function readBookings(){
  const sheet = getSheet();
  const cols = getColumns(sheet).map;
  const data = sheet.getDataRange().getValues();
  const out = [];
  for(let i = 1; i < data.length; i++){
    const b = { row: i + 1 };
    HEADERS.forEach(f => { const v = data[i][cols[f]]; b[f] = (v === undefined ? "" : v); });
    b.status = String(b.status).trim();
    if(b.id || b.name || b.phone) out.push(b);
  }
  return out;
}

function setCell(sheet, cols, field, row, value){
  sheet.getRange(row, cols[field] + 1).setValue(value);
}


/* ================================================================
   3. CLIENTS & DEALS — who is who, and who used what
   ================================================================ */

// Same client no matter how the number was typed: "(555) 123-4567" = "5551234567".
function phoneKey(p){ return String(p).replace(/\D/g, "").slice(-10); }

// Friendly display: 2602982022 -> "260-298-2022". Anything else is left as typed.
function fmtPhone(p){
  const raw = (p === undefined || p === null) ? "" : String(p);
  let d = raw.replace(/\D/g, "");
  if(d.length === 11 && d[0] === "1") d = d.slice(1);
  return d.length === 10 ? d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6) : raw;
}

// When a booking was made (its id is a timestamp), so "newest" stays right even after you re-sort the Bookings tab.
function bookedAt(b){
  const m = String(b.id).match(/^b_(d{10,})/);
  if(m) return Number(m[1]);
  const t = parseSubmitted(b.submittedAt);
  return t ? t.getTime() : b.row;
}
function byNewest(a, c){ return bookedAt(c) - bookedAt(a) || c.row - a.row; }

function isActive(b){ return b.status === "pending" || b.status === "approved"; }

// Deal keys on a booking. Older bookings (before deals were tracked by key) are
// worked out from the deal names in their text.
function dealsOf(b){
  const listed = String(b.dealKeys || "").split(",").map(s => s.trim()).filter(Boolean);
  if(listed.length) return listed;
  return Object.keys(DEAL_NAMES).filter(k => String(b.dealsUsed).indexOf(DEAL_NAMES[k]) !== -1);
}

function approvedCount(all, phone, excludeRow){
  const key = phoneKey(phone);
  if(!key) return 0;
  return all.filter(b => b.row !== excludeRow && b.status === "approved" && phoneKey(b.phone) === key).length;
}

// e.g. "Back to Campus already used (approved, 09/12/2026 03:00 PM)"; empty = all clear.
function dealAlertFor(all, phone, dealKeys, excludeRow){
  const key = phoneKey(phone);
  if(!key) return "";
  const alerts = [];
  ONE_TIME_DEALS.forEach(deal => {
    if(dealKeys.indexOf(deal) === -1) return;
    const earlier = all.filter(b => b.row !== excludeRow && phoneKey(b.phone) === key && isActive(b) && dealsOf(b).indexOf(deal) !== -1);
    if(earlier.length){
      const last = earlier[earlier.length - 1];
      alerts.push(DEAL_NAMES[deal] + " already used (" + last.status + ", " + asText(last.submittedAt) + ")");
    }
  });
  return alerts.join(" · ");
}

// Client's visit number if this booking gets approved, and whether it earns a loyalty gift.
function applyApproval(sheet, cols, row){
  const all = readBookings();
  const me = all.find(b => b.row === row);
  if(!me) return null;
  const visits = approvedCount(all, me.phone, row) + 1;
  setCell(sheet, cols, "visitCount", row, visits);
  setCell(sheet, cols, "loyaltyFlag", row, visits % LOYALTY_SURPRISE_EVERY === 0);
  return me;
}


/* ================================================================
   3b. SMART CHECKS — the sheet does the checking so you don't have to
   ================================================================ */

function isBundle(b){ return /^bundle/i.test(String(b.serviceLabel)); }

function isConsult(b){ return /^consultation/i.test(String(b.serviceLabel)); }

function isTrue(v){ return v === true || String(v).toUpperCase() === "TRUE"; }

function isPaid(b){ return b.depositPaid === true || String(b.depositPaid).toUpperCase() === "TRUE"; }

function isRefunded(b){ return b.depositRefunded === true || String(b.depositRefunded).toUpperCase() === "TRUE"; }

function isComp(b){ return b.kitComp === true || String(b.kitComp).toUpperCase() === "TRUE"; }

// Money actually received from the client (typed in by you). Blank = not recorded, so the booking total is used.
function hasReceived(b){ return String(b.amountPaid).trim() !== "" && !isNaN(Number(b.amountPaid)); }

// A grand total you typed on the Dashboard overrides the automatic one. Blank = automatic.
function hasGrandOverride(b){ return String(b.grandTotal).trim() !== "" && !isNaN(Number(b.grandTotal)); }

function isShipped(b){ return isTrue(b.shipped); }

function isServiced(b){ return isTrue(b.serviced); }

function isPacked(b){ return b.kitPacked === true || String(b.kitPacked).toUpperCase() === "TRUE"; }

// "Luxury" / "Mini" / "—" — which care kit to pack for this booking.
function kitTier(b){
  const t = String(b.giftKit) + " " + String(b.careKitCost);
  return /luxury/i.test(t) ? "Luxury" : /mini/i.test(t) ? "Mini" : "—";
}

function parseSubmitted(v){
  if(v instanceof Date) return v;
  if(typeof v === "number" && v > 1e11) return new Date(v);
  const s = String(v).trim();
  if(/^\d{12,13}$/.test(s)) return new Date(Number(s));
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/);
  if(!m) return null;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]) % 12 + (m[6] === "PM" ? 12 : 0), Number(m[5]));
}

function parseDay(b){
  const m = asDate(b.date).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
}

function parseMinutes(b){
  const m = asTime(b.time).match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  return m ? (Number(m[1]) % 12 + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]) : null;
}

function dayKey(d){ return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

// How long a pending request has been waiting, and whether it's past your reply promise.
function waitInfo(b, responseHours){
  const d = parseSubmitted(b.submittedAt);
  if(!d) return { text: "—", overdue: false };
  const h = (Date.now() - d.getTime()) / 3600000;
  const text = h < 1 ? "<1h" : h < 24 ? Math.floor(h) + "h" : Math.floor(h / 24) + "d " + Math.floor(h % 24) + "h";
  return { text: text, overdue: h >= (responseHours || getSettings().responseHours) };
}

function normName(s){ return String(s).toLowerCase().replace(/[^a-z ]/g, "").trim(); }
function normIg(s){ return String(s).toLowerCase().replace(/[^a-z0-9._]/g, ""); }

// For a Couple's/Bestie Deal: find the partner's own booking (matched by their phone,
// Instagram, or name as the client typed it).
function findPartner(a, live){
  const pName = normName(a.partnerName), pPhone = phoneKey(a.partnerContact), pIg = normIg(a.partnerContact);
  return live.find(b => {
    if(b.row === a.row || phoneKey(b.phone) === phoneKey(a.phone) || b.bookingType !== a.bookingType) return false;
    const byContact = (pPhone.length === 10 && phoneKey(b.phone) === pPhone) || (pIg.length > 2 && pIg === normIg(b.ig));
    const bn = normName(b.name);
    const byName = pName.length >= 3 && bn && (bn === pName || bn.indexOf(pName) !== -1 || pName.indexOf(bn) !== -1);
    return byContact || byName;
  });
}

// One line of "things to look at" per booking, keyed by sheet row. ⚠ = needs your attention.
function computeChecks(all, minGapMinutes){
  minGapMinutes = minGapMinutes || getSettings().minGapMinutes;
  const notes = {};
  const add = (row, t) => (notes[row] = notes[row] || []).push(t);
  const live = all.filter(isActive);

  // no-show policy: no rebooking after a no-show
  live.forEach(b => {
    const key = phoneKey(b.phone);
    if(!key) return;
    const ns = all.filter(x => x.status === "no-show" && phoneKey(x.phone) === key);
    if(ns.length) add(b.row, "⚠ No-show on record (" + (asDate(ns[ns.length - 1].date) || "date unknown") + ") — policy: no rebooking");
  });

  // double-booking: two appointments too close together on the same day
  const slots = live.filter(b => !isBundle(b)).map(b => ({ b: b, day: parseDay(b), min: parseMinutes(b) }))
                    .filter(s => s.day && s.min !== null);
  slots.forEach((a, i) => slots.forEach((c, j) => {
    if(i < j && dayKey(a.day) === dayKey(c.day) && Math.abs(a.min - c.min) < minGapMinutes){
      add(a.b.row, "⚠ Too close to " + c.b.name + " (" + asTime(c.b.time) + ")");
      add(c.b.row, "⚠ Too close to " + a.b.name + " (" + asTime(a.b.time) + ")");
    }
  }));

  // Couple's / Bestie Deal: has the partner booked, and on a different day?
  live.filter(b => b.bookingType === "couple" || b.bookingType === "bestie").forEach(a => {
    const label = a.bookingType === "couple" ? "Couple Booking" : "Bestie Booking";
    const partner = findPartner(a, live);
    if(!partner) add(a.row, "⚠ " + label + ": " + (a.partnerName || a.partnerContact || "partner") + " hasn't booked yet");
    else if(asDate(partner.date) && asDate(partner.date) === asDate(a.date)) add(a.row, "⚠ " + label + ": same day as " + partner.name + " (must be different days)");
    else add(a.row, "✓ " + label + ": " + partner.name + " booked " + (asDate(partner.date) || "(no date)"));
  });

  const out = {};
  Object.keys(notes).forEach(r => out[r] = notes[r].join(" · "));
  return out;
}

// Keeps the "checks" column current (only writes cells that actually changed).
function syncChecks(all){
  const sheet = getSheet();
  const cols = getColumns(sheet).map;
  const checks = computeChecks(all, getSettings().minGapMinutes);
  all.forEach(b => {
    const t = checks[b.row] || "";
    if(String(b.checks) !== t){ setCell(sheet, cols, "checks", b.row, t); b.checks = t; }
  });
}

function hasWarning(b){ return !!b.dealAlert || String(b.checks).indexOf("⚠") !== -1; }

// --- ready-to-send text messages (copy, paste, send) ---

function firstName(b){ return String(b.name).trim().split(/\s+/)[0] || "there"; }

function whenText(b){
  const d = asDate(b.date), t = asTime(b.time);
  return d ? (t ? d + " at " + t : d) : "your requested date";
}

function messageFor(b, depositAmount){
  depositAmount = depositAmount || getSettings().depositAmount;
  const hi = "Hi " + firstName(b) + "! ";
  if(isBundle(b) && b.status !== "denied")
    return hi + "Thanks for your bundle request! I'm confirming pricing and shipping timing and will text you your final price and pickup date shortly.";
  if(b.status === "pending")
    return hi + "Your " + b.serviceLabel + " on " + whenText(b) + " is approved! To lock in your spot, please send the $" + depositAmount +
           " deposit to " + CASHTAG + " on Cash App (it comes off your total at your appointment). Thank you!";
  if(b.status === "approved" && !isPaid(b))
    return hi + "Just a reminder to send your $" + depositAmount + " deposit to " + CASHTAG + " on Cash App to keep your spot on " + whenText(b) + ". Thank you!";
  if(b.status === "approved")
    return hi + "Reminder: your appointment is " + whenText(b) + ". Please come with your hair already washed and dried (I don't currently offer washing/drying services) and let me know ASAP if anything changes. See you soon!";
  return "";
}

function messageLabel(b){
  if(isBundle(b)) return "Bundle update";
  return b.status === "pending" ? "Approval text" : (b.status === "approved" && !isPaid(b)) ? "Deposit reminder" : b.status === "approved" ? "Appointment reminder" : "";
}


/* ================================================================
   4. SAVING BOOKINGS (called by the website)
   ================================================================ */

function withLock(fn){                    // stops two simultaneous bookings from colliding
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function formatDateStr(d){                // "2026-09-25" -> "09/25/2026" (plain text on purpose)
  const p = String(d || "").split("-");
  return p.length === 3 ? p[1] + "/" + p[2] + "/" + p[0] : (d || "");
}

function formatTimeStr(t){                // "15:46" -> "3:46 PM"
  const p = String(t || "").split(":");
  if(p.length < 2) return t || "";
  let h = parseInt(p[0], 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + p[1] + " " + ampm;
}

function formatTimestamp(ms){
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), "MM/dd/yyyy hh:mm a");
}

const PHOTO_MAX_CHUNKS = 100;                           // 100 pieces of ~2.4 KB = ~240 KB per photo

// Stitches the uploaded pieces of each photo back into a data URL. Skips any photo with a missing piece.
function photosFromCache(refs){
  const cache = CacheService.getScriptCache();
  const out = [];
  (refs || []).slice(0, 3).forEach(r => {
    const n = Number(r && r.n), id = String(r && r.id || "");
    if(!/^[A-Za-z0-9_]{6,60}$/.test(id) || !(n > 0 && n <= PHOTO_MAX_CHUNKS)) return;
    const keys = [];
    for(let i = 0; i < n; i++) keys.push("ph_" + id + "_" + i);
    const got = cache.getAll(keys);
    const parts = keys.map(k => got[k]);
    if(parts.some(p => p === undefined || p === null)) return;
    cache.removeAll(keys);
    out.push(parts.join(""));
  });
  return out;
}

function savePhotos(photos){
  if(!photos || !photos.length) return [];
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
  const urls = [];
  photos.forEach((dataUrl, i) => {
    try{
      const comma = dataUrl.indexOf(",");
      const type = dataUrl.substring(0, comma).match(/data:(.*?);base64/)[1];
      const blob = Utilities.newBlob(Utilities.base64Decode(dataUrl.substring(comma + 1)), type, "photo_" + Date.now() + "_" + i + ".jpg");
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urls.push(file.getUrl());
    }catch(e){ /* skip a bad photo rather than failing the whole booking */ }
  });
  return urls;
}

// Blocks rapid duplicate submissions (accidental double-clicks, or a script hammering the
// public create endpoint) from the same phone number. Looks like a normal success to whoever
// sent it — it just doesn't actually save a second row — so it gives an attacker no signal.
const CREATE_RATE_LIMIT_SECONDS = 30;
function isRecentDuplicate(all, phone){
  const key = phoneKey(phone);
  if(!key) return false;
  return all.some(b => {
    if(phoneKey(b.phone) !== key) return false;
    const t = parseSubmitted(b.submittedAt);
    return t && (Date.now() - t.getTime()) < CREATE_RATE_LIMIT_SECONDS * 1000;
  });
}

function handleCreate(body){
  return withLock(() => {
    const sheet = getSheet();
    const cols = getColumns(sheet);
    const all = readBookings();

    if(isRecentDuplicate(all, body.phone)) return { ok: true, key: "" };

    const dealKeys = String(body.dealKeys || "").split(",").map(s => s.trim()).filter(Boolean);
    const dealAlert = dealAlertFor(all, body.phone, dealKeys, -1);
    const visitCount = approvedCount(all, body.phone, -1) + 1;        // their Nth visit IF approved
    const loyaltyFlag = visitCount % LOYALTY_SURPRISE_EVERY === 0;
    const sentRefs = (body.photoIds || []).length;
    const photoUrls = savePhotos((body.photos || []).concat(photosFromCache(body.photoIds)));
    if(sentRefs && photoUrls.length < sentRefs)
      body.notes = (body.notes ? body.notes + " " : "") + "(" + (sentRefs - photoUrls.length) + " reference photo(s) failed to save — ask the client to DM them on IG)";
    const id = "b_" + Date.now() + "_" + Math.floor(Math.random() * 10000);

    const values = {
      id: id, name: body.name || "", phone: fmtPhone(body.phone), ig: body.ig || "", email: String(body.email || "").trim(),
      date: formatDateStr(body.date), time: formatTimeStr(body.time), notes: body.notes || "",
      serviceLabel: body.serviceLabel || "", total: body.total || 0, status: "pending",
      submittedAt: formatTimestamp(Date.now()), photoUrls: photoUrls.join("|"),
      dealsUsed: body.dealsLabel || "", bookingType: body.bookingType || "solo",
      partnerName: body.partnerName || "", partnerContact: body.partnerContact || "",
      giftKit: body.giftKit || "", careKitCost: body.careKitCost || "", kitComp: false, kitPacked: false,
      visitCount: visitCount, loyaltyFlag: loyaltyFlag, dealKeys: dealKeys.join(", "), dealAlert: dealAlert,
      depositPaid: false, depositRefunded: false, checks: "", approvalEmailed: false,
      shipped: false, serviced: false, servicedOn: ""
    };
    const row = new Array(cols.width).fill("");           // each value goes under its own header
    Object.keys(values).forEach(f => { row[cols.map[f]] = values[f]; });
    // Not sheet.appendRow(): formatBookingsSheet formats 1000 rows ahead, which makes Sheets
    // think those blank rows are "used" — appendRow would then drop new bookings at row 1000+
    // instead of right after your real data. Compute the real next row ourselves instead.
    const targetRow = (all.length ? Math.max.apply(null, all.map(b => b.row)) : 1) + 1;
    sheet.getRange(targetRow, 1, 1, cols.width).setValues([row]);

    const updated = readBookings();                       // recheck everything now that this booking exists
    syncChecks(updated);
    const mine = updated.find(b => b.id === id);
    values.checks = mine ? mine.checks : "";

    sendBookingEmail(body, values, photoUrls);
    refreshViews(updated);
    return { ok: true, key: id };
  });
}

function sendBookingEmail(body, v, photoUrls){
  try{
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: (hasWarning(v) ? "⚠ HEADS UP — " : "") + "New Ehiffect booking request — " + (v.name || "unknown"),
      body:
        (v.dealAlert ? "⚠ DEAL ALERT: " + v.dealAlert + "\n" : "") +
        (v.checks ? "CHECKS: " + v.checks + "\n" : "") +
        (v.dealAlert || v.checks ? "\n" : "") +
        "New booking request!\n\n" +
        "Name: " + v.name + "\nPhone: " + v.phone + "\nIG: " + v.ig + "\n" +
        "Service: " + v.serviceLabel + "\n" +
        (v.dealsUsed ? "Deals: " + v.dealsUsed + "\n" : "") +
        (v.bookingType !== "solo" ? "Booking type: " + v.bookingType + " — partner: " + v.partnerName + " " + v.partnerContact + "\n" : "") +
        (v.giftKit ? "Care kit: " + v.giftKit + "\n" : "") +
        (v.careKitCost ? "Bundle care kit: " + v.careKitCost + "\n" : "") +
        "Total: $" + v.total + "\n" +
        "Preferred date/time: " + v.date + " " + v.time + "\n" +
        "Notes: " + v.notes + "\n" +
        (photoUrls.length ? "Photos:\n" + photoUrls.join("\n") + "\n" : "") +
        (v.loyaltyFlag ? "\n🎉 If approved, this would be visit #" + v.visitCount + " for this client — surprise loyalty gift time!\n" : "") +
        "\nApprove or deny it from your dashboard."
    });
  }catch(err){ /* an email hiccup must never block the booking from saving */ }
}

function handleUpdateStatus(body){
  return withLock(() => {
    const sheet = getSheet();
    const cols = getColumns(sheet).map;
    const target = readBookings().find(b => b.id === body.key);
    if(!target) return { ok: false };
    setCell(sheet, cols, "status", target.row, body.status);
    if(body.status === "approved"){
      applyApproval(sheet, cols, target.row);
      sendApprovalEmail(target);          // target.status is still "pending" here, which is exactly
    }                                      // the wording messageFor() needs for the approval message
    refreshViews();
    return { ok: true };
  });
}

// Emails the client once you approve their booking — only if they gave an email (it's optional
// on the site). Reuses the same approval wording as the copy-paste text on your Dashboard.
// A spaced-out, email-shaped version of the approval message — messageFor() is written as one
// dense sentence for a text message, which reads as a cramped wall of text in an email inbox.
function approvalEmailBody(b, depositAmount){
  const lines = [
    "Hi " + firstName(b) + ",",
    "",
    isBundle(b) ? "Good news — I'm confirming your bundle order!" : "Good news — your appointment is approved!",
    "",
    "Service: " + b.serviceLabel,
    "When: " + whenText(b),
    ""
  ];
  if(isBundle(b)){
    lines.push("I'll text you shortly to confirm your final price and pickup date.");
  }else{
    lines.push("To lock in your spot, please send a $" + depositAmount + " deposit to " + CASHTAG + " on Cash App.");
    lines.push("This comes off your total at your appointment.");
  }
  lines.push("");
  lines.push("Questions? Just reply to this email or DM @ehiffect on Instagram.");
  lines.push("");
  lines.push("See you soon!");
  return lines.join("\n");
}

function sendApprovalEmail(b){
  if(!b.email || isTrue(b.approvalEmailed)) return;      // no address, or they already got this email
  try{
    MailApp.sendEmail({
      to: b.email,
      subject: "Your Ehiffect appointment is approved!",
      body: approvalEmailBody(b, getSettings().depositAmount)
    });
    try{
      const sh = getSheet(), cm = getColumns(sh).map;
      setCell(sh, cm, "approvalEmailed", b.row, true);
      setCell(sh, cm, "lastEmail", b.row, "Approval (automatic) → " + b.email + " · " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yyyy h:mm a"));
    }catch(markErr){}
  }catch(err){
    // Never let an email hiccup block the status update — but tell you about it instead of
    // failing completely silently, so a bad address or quota issue doesn't go unnoticed.
    try{
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: "⚠ Approval email to " + (b.name || "a client") + " failed to send",
        body: "Tried to email " + (b.email || "(no email)") + " when approving this booking, but it failed:\n\n" + err.message
      });
    }catch(err2){ /* truly nothing more we can do here */ }
  }
}


function handleSetDeposit(body){
  return withLock(() => {
    const sheet = getSheet();
    const cols = getColumns(sheet).map;
    const target = readBookings().find(b => b.id === body.key);
    if(!target) return { ok: false };
    setCell(sheet, cols, "depositPaid", target.row, !!body.paid);
    refreshViews();
    return { ok: true };
  });
}


/* ================================================================
   5. WEBSITE API
   ================================================================ */

function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function toWebsiteShape(b, settings){
  const wait = waitInfo(b, settings.responseHours);
  return {
    key: b.id, name: b.name, phone: fmtPhone(b.phone), ig: b.ig, date: asDate(b.date), time: asTime(b.time), notes: b.notes,
    serviceLabel: b.serviceLabel, total: b.total, status: b.status, submittedAt: asText(b.submittedAt),
    photos: b.photoUrls ? String(b.photoUrls).split("|") : [], dealsUsed: b.dealsUsed || "",
    bookingType: b.bookingType || "solo", partnerName: b.partnerName || "", partnerContact: b.partnerContact || "",
    giftKit: b.giftKit || "", careKitCost: b.careKitCost || "", kitComp: isComp(b), visitCount: b.visitCount || 0,
    loyaltyFlag: b.loyaltyFlag || false, dealKeys: b.dealKeys || "", dealAlert: b.dealAlert || "",
    depositPaid: isPaid(b), depositRefunded: isRefunded(b), checks: b.checks || "", kit: kitTier(b), isBundle: isBundle(b),
    waiting: b.status === "pending" ? wait.text : "", overdue: b.status === "pending" && wait.overdue,
    text: messageFor(b, settings.depositAmount), textLabel: messageLabel(b)
  };
}

function doGet(e){
  const action = e.parameter.action;

  if(action === "list"){
    if(e.parameter.key !== ADMIN_KEY) return json({ error: "unauthorized" });
    const settings = getSettings();
    return json({ bookings: readBookings().map(b => toWebsiteShape(b, settings)) });
  }

  // Privacy-friendly: answers yes/no for ONE phone number, never exposes the client list.
  if(action === "checkVisits"){
    const count = approvedCount(readBookings(), e.parameter.phone || "", -1);
    return json({ approvedCount: count, isFirstTime: count === 0 });
  }

  // Whole days already spoken for — just dates, no names/phones, so the site's calendar can
  // grey them out for new bookers. A day closes the moment someone books it (pending or
  // approved) and reopens as soon as that booking is denied, cancelled, rescheduled, or no-show.
  // Bundle orders (pickup, not a chair slot) and consultations (a phone call) never block a day.
  if(action === "takenDates"){
    const dates = readBookings()
      .filter(b => isActive(b) && !isBundle(b) && !isConsult(b))
      .map(b => asDate(b.date))
      .filter(Boolean);
    return json({ dates: Array.from(new Set(dates)) });
  }

  // One small piece of a reference photo (photos are too big for the booking request itself).
  // Held briefly in the script cache until the booking arrives and stitches them together.
  if(action === "photoChunk"){
    const id = String(e.parameter.id || ""), i = Number(e.parameter.i), data = String(e.parameter.data || "");
    if(!/^[A-Za-z0-9_]{6,60}$/.test(id) || !(i >= 0 && i < PHOTO_MAX_CHUNKS) || !data) return json({ error: "bad chunk" });
    CacheService.getScriptCache().put("ph_" + id + "_" + i, data, 1800);
    return json({ ok: true });
  }

  if(action === "create" || action === "updateStatus" || action === "setDeposit"){
    let body;
    try{ body = JSON.parse(e.parameter.payload); }
    catch(err){ return json({ error: "bad payload" }); }
    if(action !== "create" && body.adminKey !== ADMIN_KEY) return json({ error: "unauthorized" });
    if(action === "create") return json(handleCreate(body));
    if(action === "updateStatus") return json(handleUpdateStatus(body));
    return json(handleSetDeposit(body));
  }

  return json({ error: "unknown action" });
}

// Fallback in case anything ever reaches doPost directly; the website doesn't rely on it.
function doPost(e){
  let body;
  if(e.parameter && e.parameter.payload) body = JSON.parse(e.parameter.payload);
  else if(e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  else return json({ error: "no data received" });
  if(body.action === "create") return json(handleCreate(body));
  if(body.action === "updateStatus"){
    if(body.adminKey !== ADMIN_KEY) return json({ error: "unauthorized" });
    return json(handleUpdateStatus(body));
  }
  return json({ error: "unknown action" });
}


/* ================================================================
   6. AUTOMATIC UPDATES & MENU
   ================================================================ */

function onOpen(){
  SpreadsheetApp.getUi().createMenu("Ehiffect")
    .addItem("Refresh dashboard & clients", "refreshViews")
    .addItem("Set up / restyle all sheets", "formatSheet")
    .addItem("Sort Bookings newest first", "sortBookingsNewestFirst")
    .addItem("Sync approved bookings to Google Calendar", "syncCalendarNow")
    .addItem("Turn on approval emails", "setupApprovalEmails")
    .addToUi();
}

// Fixed cell addresses on the Dashboard that react to clicks / typing. writeDashboardSheet builds the
// sheet around these, and handleSheetEdit listens to them — change them in one place only.
const DASH = {
  REV: "B8",                                         // show/hide revenue tick
  PICK: "B23",                                       // "Open a booking" dropdown
  DEP: "H26", GRAND: "H27", RECV: "H28", SERV: "H29", PACK: "H30", SHIP: "H31",   // the card's ticks / inputs
  GRAND_NOTE: "I27",
  MAIL_TYPE: "B34", MAIL_SUBJECT: "E34", MAIL_BODY: "B35", SEND: "H36", SEND_NOTE: "I36",
  KPICK: "B39", KPACK: "H40", KSHIP: "H41"           // Kits section
};

const EMAIL_TYPES = [
  "Approval — you're booked", "Deposit reminder", "Appointment reminder", "Can't take this booking",
  "Reschedule — pick a new date", "Kit shipped", "Thank you"
];

// Which template makes sense for this booking right now.
function defaultEmailType(b){
  if(!b) return EMAIL_TYPES[0];
  if(b.status === "denied" || b.status === "cancelled") return EMAIL_TYPES[3];
  if(b.status === "rescheduled") return EMAIL_TYPES[4];
  if(isServiced(b)) return EMAIL_TYPES[6];
  if(b.status === "pending") return EMAIL_TYPES[0];
  if(b.status === "approved" && !isPaid(b)) return EMAIL_TYPES[1];
  return EMAIL_TYPES[2];
}

// The little ready-made email for a booking. You can edit the text in the sheet before sending.
function emailTemplate(type, b, dep){
  if(!b) return { subject: "", body: "" };
  const hi = "Hi " + firstName(b) + ",\n\n";
  const footer = "\n\nQuestions? Just reply to this email or DM @ehiffect on Instagram.\n\n— Ehiffect";
  const owed = isPaid(b) && !isRefunded(b);
  switch(EMAIL_TYPES.indexOf(type)){
    case 1:
      return { subject: "Quick reminder: your Ehiffect deposit",
        body: hi + "Just a reminder to send your $" + dep + " deposit to " + CASHTAG + " on Cash App to keep your spot on " + whenText(b) +
              ". It comes off your total at your appointment." + footer };
    case 2:
      return { subject: "Reminder: your Ehiffect appointment",
        body: hi + "A reminder that your " + b.serviceLabel + " is " + whenText(b) + ". Please come with your hair already washed and dried " +
              "(I don't currently offer washing/drying services), and let me know ASAP if anything changes. See you soon!" + footer };
    case 3:
      return { subject: "About your Ehiffect booking",
        body: hi + "Thank you so much for requesting " + b.serviceLabel + " on " + whenText(b) + ". Unfortunately I'm not able to take that booking." +
              (owed ? " Your $" + dep + " deposit will be sent back to you." : "") +
              " I'd love to find another time that works — you're welcome to book again on the site anytime." + footer };
    case 4:
      return { subject: "Let's find a new date for your Ehiffect appointment",
        body: hi + "I need to move your " + b.serviceLabel + " that was set for " + whenText(b) + ". Could you reply with a couple of dates and times " +
              "that work for you, or pick a new day on the booking site?" +
              (owed ? " Your $" + dep + " deposit carries over to the new date, so you won't pay it twice." : "") + footer };
    case 5:
      return { subject: "Your Ehiffect order has shipped",
        body: hi + "Good news — your order has shipped! Thank you so much for supporting Ehiffect. Let me know when it arrives, and reach out if you have any questions." + footer };
    case 6:
      return { subject: "Thank you from Ehiffect",
        body: hi + "Thank you so much for coming in — I hope you love your " + b.serviceLabel + "! If you post it, tag @ehiffect so I can see it." + footer };
    default:
      return { subject: "Your Ehiffect appointment is approved!", body: approvalEmailBody(b, dep) };
  }
}

// Changing a Status dropdown in the Bookings tab keeps everything else in sync, and emails the
// client when it becomes "approved". The Dashboard's ticks and boxes are handled below too.
//
// This is deliberately NOT named onEdit: Google runs a plain onEdit() with restricted permissions,
// and one thing it blocks is sending email — so approving from the dropdown silently never emailed
// anyone (approving from the website worked because that runs differently). Running it as an
// installable trigger (set up by ensureEditTrigger below) gives it permission to send.
function handleSheetEdit(e){
  try{
    const sheet = e.range.getSheet();
    if(sheet.getName() === "Dashboard"){
      handleDashboardEdit(sheet, e.range.getA1Notation().split(":")[0]);   // merged cells report a range; use its first cell
      return;
    }
    if(sheet.getName() !== "Bookings" || e.range.getRow() < 2) return;
    const cols = getColumns(sheet).map;
    const col = e.range.getColumn();
    const watched = [cols.status, cols.depositPaid, cols.depositRefunded, cols.kitComp, cols.kitPacked, cols.shipped, cols.serviced,
                     cols.amountPaid, cols.grandTotal, cols.date, cols.time].map(i => i + 1);
    if(watched.indexOf(col) === -1) return;
    if(col === cols.serviced + 1) stampServiced(sheet, cols, e.range.getRow(), e.range.getValue() === true);
    if(col === cols.status + 1 && String(e.value).trim() === "approved"){
      const approvedBooking = applyApproval(sheet, cols, e.range.getRow());
      if(approvedBooking) sendApprovalEmail(approvedBooking);
    }
    refreshViews();
  }catch(err){ console.error("handleSheetEdit failed: " + err); }
}

// Writes the Serviced tick's date (stamped the first time it's ticked, cleared on untick).
function stampServiced(sheet, cols, row, on){
  const dateCell = sheet.getRange(row, cols.servicedOn + 1);
  if(on){ if(!String(dateCell.getValue()).trim()) dateCell.setNumberFormat("@").setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yyyy")); }
  else dateCell.setValue("");
}

// Everything you can click or type on the Dashboard. Choosing a booking just loads its current ticks
// into the boxes; ticking / typing writes straight to that booking in Bookings and refreshes the sheet.
function handleDashboardEdit(dash, a1){
  const settingCells = { C9: "depositAmount", E9: "responseHours", G9: "minGapMinutes" };
  if(settingCells[a1]){
    const n = Number(dash.getRange(a1).getValue());
    if(!isNaN(n) && n > 0) saveSetting(settingCells[a1], n);
    refreshViews();
    return;
  }
  if(a1 === DASH.REV){ refreshViews(); return; }                // shows / hides the revenue + charts panel

  const openRow = label => Number((String(label).match(/^#(\d+)/) || [])[1]);

  // ---- Kits section ----
  if(a1 === DASH.KPICK || a1 === DASH.KPACK || a1 === DASH.KSHIP){
    const row = openRow(dash.getRange(DASH.KPICK).getValue());
    if(!row) return;
    const bookings = getSheet(), colMap = getColumns(bookings).map;
    if(a1 === DASH.KPICK){
      dash.getRange(DASH.KPACK).setValue(isTrue(bookings.getRange(row, colMap.kitPacked + 1).getValue()));
      dash.getRange(DASH.KSHIP).setValue(isTrue(bookings.getRange(row, colMap.shipped + 1).getValue()));
      return;
    }
    setCell(bookings, colMap, a1 === DASH.KPACK ? "kitPacked" : "shipped", row, dash.getRange(a1).getValue() === true);
    refreshViews();
    return;
  }

  // ---- Open a booking card + email ----
  const cardCells = [DASH.PICK, DASH.DEP, DASH.GRAND, DASH.RECV, DASH.SERV, DASH.PACK, DASH.SHIP, DASH.MAIL_TYPE, DASH.SEND];
  if(cardCells.indexOf(a1) === -1) return;
  const row = openRow(dash.getRange(DASH.PICK).getValue());
  if(!row) return;
  const dep = getSettings().depositAmount;

  if(a1 === DASH.PICK){ loadCard(dash, row, dep); return; }

  if(a1 === DASH.MAIL_TYPE){
    const b = readBookings().filter(x => x.row === row)[0];
    const t = emailTemplate(String(dash.getRange(DASH.MAIL_TYPE).getValue()), b, dep);
    dash.getRange(DASH.MAIL_SUBJECT).setValue(t.subject);
    dash.getRange(DASH.MAIL_BODY).setValue(t.body);
    return;
  }
  if(a1 === DASH.SEND){
    if(dash.getRange(DASH.SEND).getValue() === true) sendCardEmail(dash, row);
    return;
  }

  const bookings = getSheet(), colMap = getColumns(bookings).map;
  const cell = dash.getRange(a1), val = cell.getValue();
  if(a1 === DASH.DEP) setCell(bookings, colMap, "depositPaid", row, val === true);
  else if(a1 === DASH.PACK) setCell(bookings, colMap, "kitPacked", row, val === true);
  else if(a1 === DASH.SHIP) setCell(bookings, colMap, "shipped", row, val === true);
  else if(a1 === DASH.SERV){
    setCell(bookings, colMap, "serviced", row, val === true);
    stampServiced(bookings, colMap, row, val === true);
  }
  else if(a1 === DASH.RECV){
    if(val !== "" && isNaN(Number(val))) return;
    setCell(bookings, colMap, "amountPaid", row, val === "" ? "" : Number(val));
  }
  else if(a1 === DASH.GRAND){                                    // typing a number overrides it; clearing goes back to automatic
    if(val !== "" && isNaN(Number(val))) return;
    setCell(bookings, colMap, "grandTotal", row, val === "" ? "" : Number(val));
  }
  refreshViews();
}

// Loads one booking's current state into the card's ticks / boxes and drafts its email.
function loadCard(dash, row, dep){
  const b = readBookings().filter(x => x.row === row)[0];
  if(!b) return;
  dash.getRange(DASH.DEP).setValue(isPaid(b));
  dash.getRange(DASH.GRAND).setValue(grandTotalOf(b, dep));
  dash.getRange(DASH.GRAND_NOTE).setValue(grandNote(b));
  dash.getRange(DASH.RECV).setValue(hasReceived(b) ? Number(b.amountPaid) : "");
  dash.getRange(DASH.SERV).setValue(isServiced(b));
  dash.getRange(DASH.PACK).setValue(isPacked(b));
  dash.getRange(DASH.SHIP).setValue(isShipped(b));
  const type = defaultEmailType(b), t = emailTemplate(type, b, dep);
  dash.getRange(DASH.MAIL_TYPE).setValue(type);
  dash.getRange(DASH.MAIL_SUBJECT).setValue(t.subject);
  dash.getRange(DASH.MAIL_BODY).setValue(t.body);
  dash.getRange(DASH.SEND).setValue(false);
  dash.getRange(DASH.SEND_NOTE).setValue("");
}

// Sends the email shown in the card (subject + message exactly as written there) to the client.
function sendCardEmail(dash, row){
  const box = dash.getRange(DASH.SEND), note = dash.getRange(DASH.SEND_NOTE);
  const b = readBookings().filter(x => x.row === row)[0];
  const to = b ? String(b.email || "").trim() : "";
  const subject = String(dash.getRange(DASH.MAIL_SUBJECT).getValue()).trim();
  const body = String(dash.getRange(DASH.MAIL_BODY).getValue());
  box.setValue(false);                                           // un-tick straight away so it can't double-send
  if(!b){ note.setValue("⚠ Couldn't find that booking — pick it again."); return; }
  if(!to){ note.setValue("⚠ No email address on file for " + b.name + " — text them instead."); return; }
  if(!subject || !body.trim()){ note.setValue("⚠ Subject or message is empty."); return; }
  try{
    MailApp.sendEmail({ to: to, subject: subject, body: body });
    const type = String(dash.getRange(DASH.MAIL_TYPE).getValue());
    const bookings = getSheet(), colMap = getColumns(bookings).map;
    if(type === EMAIL_TYPES[0]) setCell(bookings, colMap, "approvalEmailed", row, true);
    setCell(bookings, colMap, "lastEmail", row, type + " → " + to + " · " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/dd/yyyy h:mm a"));
    refreshViews();                                              // the "Last email sent" line under the message now shows it
  }catch(err){
    note.setValue("⚠ Couldn't send: " + err.message);
  }
}

// Menu item: puts the newest booking at the top of the Bookings tab (newest = largest id, which is
// a timestamp). New bookings still land at the bottom, so run this again whenever you want it re-sorted.
function sortBookingsNewestFirst(){
  const sheet = getSheet();
  const cols = getColumns(sheet);
  const all = readBookings();
  if(all.length < 2) return;
  const last = Math.max.apply(null, all.map(b => b.row));
  sheet.getRange(2, 1, last - 1, cols.width).sort({ column: cols.map.id + 1, ascending: false });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ss.getSheetByName("Dashboard");
  if(dash){ try{ dash.getRange(DASH.PICK).clearContent(); dash.getRange(DASH.KPICK).clearContent(); }catch(e){} }   // row numbers just changed
  refreshViews();
  ss.toast("Bookings sorted — newest at the top.", "Ehiffect", 6);
}

// Makes sure the installable edit trigger exists (safe to run any time; never makes a duplicate).
// formatSheet calls this, so re-running it after pasting an update is enough.
function ensureEditTrigger(){
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === "handleSheetEdit");
  if(!exists) ScriptApp.newTrigger("handleSheetEdit").forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
  return !exists;
}

function setupApprovalEmails(){
  const created = ensureEditTrigger();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    created ? "Done — approving from the Status dropdown will now email the client." : "Already on — nothing to change.", "Ehiffect", 8);
}


/* ================================================================
   7. DASHBOARD & CLIENTS TABS (rebuilt automatically)
   ================================================================ */

function refreshViews(prefetched){
  try{
    const all = prefetched || readBookings();
    syncChecks(all);
    syncCalendar();                                              // before the sheets are drawn so the Dashboard can show how it went
    const clients = buildClients(all);
    writeClientsSheet(clients);
    writeKitsSheet(all);
    writeMovedSheet(all);
    writeDashboardSheet(all, clients);
  }catch(err){ console.error("refreshViews failed: " + err); }
}

// Keeps your Google Calendar matching the approved bookings. Cheap on repeat runs: each booking stores a
// fingerprint of what its event looks like, and the calendar is only touched when that changes.
// Returns { added, updated, removed } or { error } so the menu item can tell you what went wrong.
function syncCalendar(){
  let r;
  try{ r = syncCalendarCore(); }catch(err){ r = { error: String(err && err.message || err) }; }
  try{
    PropertiesService.getScriptProperties().setProperty("calendarStatus", JSON.stringify({
      ok: !r.error, text: r.error ? r.error : "synced", at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMM d, h:mm a") }));
  }catch(e){}
  return r;
}

function syncCalendarCore(){
  if(!CALENDAR_SYNC) return { added: 0, updated: 0, removed: 0 };
  let cal;
  try{ cal = CALENDAR_ID ? CalendarApp.getCalendarById(CALENDAR_ID) : CalendarApp.getDefaultCalendar(); }
  catch(err){ return { error: "can't open the calendar: " + err.message }; }
  if(!cal) return { error: "couldn't find that calendar — share it with this Google account (Make changes to events) and check CALENDAR_ID" };

  const all = readBookings();                                   // fresh read: the event column may have just changed
  const sheet = getSheet(), cm = getColumns(sheet).map;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = { added: 0, updated: 0, removed: 0 };

  all.forEach(b => {
    const stored = String(b.calendarEvent || "");
    const eventId = stored.split("|")[0], oldSig = stored.split("|")[1] || "";
    const day = parseDay(b), mins = parseMinutes(b);
    const want = b.status === "approved" && day && day >= today;
    try{
      if(!want){
        if(eventId && b.status !== "approved"){                   // no longer approved → take it off the calendar
          const ev = cal.getEventById(eventId);
          if(ev) ev.deleteEvent();
          setCell(sheet, cm, "calendarEvent", b.row, "");
          out.removed++;
        }
        return;
      }
      const short = isBundle(b) || isConsult(b);
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, mins === null ? 9 * 60 : mins);
      const end = new Date(start.getTime() + (short ? 30 : CALENDAR_HOURS * 60) * 60000);
      const title = (isBundle(b) ? "📦 " : isConsult(b) ? "📞 " : "💗 ") + (b.name || "Client") + " — " + (b.serviceLabel || "Ehiffect");
      const description = [
        "Phone: " + fmtPhone(b.phone), b.ig ? "IG: " + b.ig : "", b.email ? "Email: " + b.email : "",
        "Total: $" + (b.total === "" ? "?" : b.total) + "  ·  Deposit: " + (isPaid(b) ? "paid" : "NOT paid yet"),
        b.dealsUsed ? "Deals: " + b.dealsUsed : "", kitTier(b) !== "—" ? "Care kit: " + kitTier(b) : "",
        b.notes ? "Notes: " + b.notes : "", "(Bookings row " + b.row + ")"
      ].filter(Boolean).join("\n");
      const sig = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, [title, start.getTime(), end.getTime(), description].join("§"))).slice(0, 12);
      let ev = null;
      if(eventId){ try{ ev = cal.getEventById(eventId); }catch(e){} }
      if(ev && sig === oldSig) return;                            // already up to date
      if(ev){
        ev.setTitle(title); ev.setTime(start, end); ev.setDescription(description);
        out.updated++;
      }else{
        ev = cal.createEvent(title, start, end, { description: description });
        out.added++;
      }
      setCell(sheet, cm, "calendarEvent", b.row, ev.getId() + "|" + sig);
    }catch(err){ out.error = "row " + b.row + ": " + err.message; }
  });
  return out;
}

// Menu item: runs the calendar sync now and tells you what happened.
function syncCalendarNow(){
  const ui = SpreadsheetApp.getUi();
  const r = syncCalendar();
  if(!r.error){
    ui.alert("Calendar synced ✓", r.added + " added, " + r.updated + " changed, " + r.removed + " removed.\n\nCalendar used: " +
      (CALENDAR_ID || "the account that owns this sheet (default calendar)") + "\n\nOnly APPROVED bookings with a date from today onward are added.", ui.ButtonSet.OK);
    return;
  }
  let hint = "";
  if(/find that calendar|can't open/i.test(r.error))
    hint = "\n\nFIX: in the OTHER account's Google Calendar → Settings → your calendar → Share with specific people → add the account that owns this sheet with \"Make changes to events\". Also check CALENDAR_ID in Code.gs is exactly that account's email.";
  else if(/permission|authoriz|not allowed|access/i.test(r.error))
    hint = "\n\nFIX: in the Apps Script editor pick \"syncCalendarNow\" in the function dropdown, press Run, and click Allow on the Calendar permission screen. Then redeploy (Deploy → Manage deployments → pencil → New version → Deploy).";
  ui.alert("Calendar sync problem ⚠", r.error + hint, ui.ButtonSet.OK);
}

function getOrCreateSheet(name){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// --- Safe display text. Older rows can hold real dates, or raw millisecond timestamps
//     like 1789652770960, so every value shown on a sheet passes through these. ---

function asText(v){                                   // "submitted at" style timestamps
  if(v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "MM/dd/yyyy hh:mm a");
  if(typeof v === "number" && v > 1e11) return formatTimestamp(v);
  if(/^\d{12,13}$/.test(String(v))) return formatTimestamp(Number(v));
  return String(v === undefined || v === null ? "" : v);
}

function asDate(v){                                   // appointment date -> 09/23/2026
  if(v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "MM/dd/yyyy");
  if(/^\d{4}-\d{2}-\d{2}/.test(String(v))) return formatDateStr(String(v).slice(0, 10));
  return String(v === undefined || v === null ? "" : v);
}

function asTime(v){                                   // appointment time -> 2:30 PM
  if(v instanceof Date) return timeFromDate(v);
  if(/^\d{1,2}:\d{2}$/.test(String(v))) return formatTimeStr(v);
  return String(v === undefined || v === null ? "" : v);
}

// Sheets stores a bare time as a date back in 1899, which can drift by a few minutes in
// some timezones. Appointments are on 15-minute steps, so snap back to the nearest one.
function timeFromDate(v){
  const tz = Session.getScriptTimeZone();
  const mins = Number(Utilities.formatDate(v, tz, "H")) * 60 + Number(Utilities.formatDate(v, tz, "m"));
  const snapped = Math.round(mins / 15) * 15;
  const h = Math.floor(snapped / 60) % 24, m = snapped % 60;
  return formatTimeStr(h + ":" + (m < 10 ? "0" + m : m));
}

function dealSummary(bookings){
  const counts = {};
  bookings.filter(isActive).forEach(b => dealsOf(b).forEach(d => counts[d] = (counts[d] || 0) + 1));
  return counts;
}

function buildClients(all){
  const groups = {};
  all.forEach(b => {
    const key = phoneKey(b.phone) || ("name:" + String(b.name).toLowerCase().trim());
    (groups[key] = groups[key] || []).push(b);
  });
  return Object.keys(groups).map(key => {
    const bs = groups[key];
    bs.sort((a, c) => bookedAt(a) - bookedAt(c));           // oldest → newest, however the Bookings tab is sorted
    const last = bs[bs.length - 1];
    const visits = bs.filter(b => b.status === "approved").length;
    const counts = dealSummary(bs);
    const used = Object.keys(counts).map(d => (DEAL_NAMES[d] || d) + (counts[d] > 1 ? " ×" + counts[d] : ""));
    const oneTime = ONE_TIME_DEALS.filter(d => counts[d]).map(d => DEAL_NAMES[d]);
    const ig = bs.map(b => b.ig).filter(Boolean).pop() || "";
    return {
      lastRow: bookedAt(last), name: last.name, phone: fmtPhone(last.phone), ig: ig,
      type: visits === 0 ? "Awaiting first visit" : visits === 1 ? "New client" : visits < LOYALTY_SURPRISE_EVERY ? "Returning" : "Regular",
      visits: visits, bookings: bs.length,
      deals: used.join(", ") || "—", oneTime: oneTime.join(", ") || "—",
      loyalty: visits === 0 ? "—" : visits % LOYALTY_SURPRISE_EVERY === 0 ? "Surprise gift due" : (LOYALTY_SURPRISE_EVERY - visits % LOYALTY_SURPRISE_EVERY) + " visits to go",
      lastBooking: asText(last.submittedAt) || "—"
    };
  }).sort((a, b) => b.lastRow - a.lastRow);
}

function styleHeaderRow(range){
  range.setBackground(COLORS.pink).setFontColor("#FFFFFF").setFontWeight("bold").setFontSize(10)
       .setVerticalAlignment("middle").setHorizontalAlignment("left");
}

function writeClientsSheet(clients){
  const sheet = getOrCreateSheet("Clients");
  const f = sheet.getFilter(); if(f) f.remove();
  sheet.setFrozenRows(0); sheet.setFrozenColumns(0);   // leftovers from older versions block merged banners
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);

  const headers = ["Client", "Phone", "Instagram", "Client type", "Visits", "Bookings", "Deals used", "One-time deals used", "Loyalty", "Last booking"];
  const W = headers.length, HEAD = 3;                 // header sits on row 3, data starts on row 4

  sheet.getRange(1, 1, 1, W).merge().setValue("Clients").setBackground(COLORS.ink).setFontColor(COLORS.cream)
       .setFontFamily("Cormorant Garamond").setFontSize(24).setFontWeight("bold").setVerticalAlignment("middle");
  sheet.getRange(2, 1, 1, W).merge()
       .setValue("Client type:  New client = 1 approved visit  ·  Returning = 2–4  ·  Regular = " + LOYALTY_SURPRISE_EVERY + "+  ·  Awaiting first visit = booked, nothing approved yet.  Visits only count approved bookings.")
       .setBackground(COLORS.cream).setFontColor(COLORS.muted).setFontSize(9).setWrap(true).setVerticalAlignment("middle");
  sheet.setRowHeight(1, 46); sheet.setRowHeight(2, 34);

  sheet.getRange(HEAD, 1, 1, W).setValues([headers]);
  styleHeaderRow(sheet.getRange(HEAD, 1, 1, W));
  sheet.setRowHeight(HEAD, 32);
  sheet.setFrozenRows(HEAD);

  if(clients.length){
    const n = clients.length, first = HEAD + 1;
    sheet.getRange(first, 2, n, 1).setNumberFormat("@");
    sheet.getRange(first, 1, n, W).setValues(clients.map(c =>
      [c.name, c.phone, c.ig, c.type, c.visits, c.bookings, c.deals, c.oneTime, c.loyalty, c.lastBooking]));
    sheet.getRange(first, 1, n, W).setFontSize(10).setVerticalAlignment("middle").setWrap(true)
         .setBackgrounds(clients.map((c, i) => new Array(W).fill(i % 2 ? COLORS.cream : "#FFFFFF")));
    sheet.getRange(first, 5, n, 2).setHorizontalAlignment("center");
    sheet.getRange(first, 1, n, 1).setFontWeight("bold");

    const typeColors = { "Awaiting first visit": COLORS.grey, "New client": COLORS.blush, "Returning": COLORS.green, "Regular": COLORS.gold };
    sheet.getRange(first, 4, n, 1).setBackgrounds(clients.map(c => [typeColors[c.type]])).setFontWeight("bold");
    clients.forEach((c, i) => {
      if(c.oneTime !== "—") sheet.getRange(first + i, 8).setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setFontWeight("bold");
      if(c.loyalty === "Surprise gift due") sheet.getRange(first + i, 9).setBackground(COLORS.gold).setFontWeight("bold");
    });
    sheet.getRange(HEAD, 1, n + 1, W).createFilter();
  }
  [170, 120, 130, 160, 60, 75, 220, 190, 130, 150].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setTabColor(COLORS.muted);
}

// Every active booking's care-kit status in one place — tick "Kit packed" in the Bookings tab
// once you've prepped it; this tab refreshes to reflect that. Sorted so unpacked kits (the
// ones you should work on right now) float to the top.
function writeKitsSheet(all){
  const sheet = getOrCreateSheet("Kits");
  const f = sheet.getFilter(); if(f) f.remove();
  sheet.setFrozenRows(0); sheet.setFrozenColumns(0);
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);

  const headers = ["Client", "Phone", "Date", "Service", "Kit", "Comp", "Packed", "Shipped", "Status"];
  const W = headers.length, HEAD = 3;

  sheet.getRange(1, 1, 1, W).merge().setValue("Kits").setBackground(COLORS.ink).setFontColor(COLORS.cream)
       .setFontFamily("Cormorant Garamond").setFontSize(24).setFontWeight("bold").setVerticalAlignment("middle");
  sheet.getRange(2, 1, 1, W).merge()
       .setValue("Every pending/approved booking's care-kit status. Tick \"Kit packed\" in the Bookings tab once it's ready — unpacked kits stay pinned to the top here.")
       .setBackground(COLORS.cream).setFontColor(COLORS.muted).setFontSize(9).setWrap(true).setVerticalAlignment("middle");
  sheet.setRowHeight(1, 46); sheet.setRowHeight(2, 34);

  sheet.getRange(HEAD, 1, 1, W).setValues([headers]);
  styleHeaderRow(sheet.getRange(HEAD, 1, 1, W));
  sheet.setRowHeight(HEAD, 32);
  sheet.setFrozenRows(HEAD);

  const rows = all.filter(isActive).sort((a, b) => {
    const aWait = kitTier(a) !== "—" && !isPacked(a), bWait = kitTier(b) !== "—" && !isPacked(b);
    if(aWait !== bWait) return aWait ? -1 : 1;                 // unpacked kits first
    const da = parseDay(a), db = parseDay(b);
    return (da ? da.getTime() : 9e15) - (db ? db.getTime() : 9e15);
  });

  if(rows.length){
    const n = rows.length, first = HEAD + 1;
    sheet.getRange(first, 2, n, 1).setNumberFormat("@");
    sheet.getRange(first, 1, n, W).setValues(rows.map(b => {
      const tier = kitTier(b);
      return [b.name, fmtPhone(b.phone), asDate(b.date) || "—", b.serviceLabel, tier,
              isComp(b) ? "Yes" : "—", tier === "—" ? "—" : (isPacked(b) ? "Yes" : "No"),
              tier === "—" ? "—" : (isShipped(b) ? "Yes" : "No"), b.status];
    }));
    sheet.getRange(first, 1, n, W).setFontSize(10).setVerticalAlignment("middle").setWrap(true)
         .setBackgrounds(rows.map((b, i) => new Array(W).fill(i % 2 ? COLORS.cream : "#FFFFFF")));
    sheet.getRange(first, 1, n, 1).setFontWeight("bold");
    rows.forEach((b, i) => {
      const tier = kitTier(b);
      if(tier === "Luxury") sheet.getRange(first + i, 5).setBackground(COLORS.gold).setFontColor("#7A5C14").setFontWeight("bold");
      if(tier !== "—" && !isPacked(b)) sheet.getRange(first + i, 7).setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setFontWeight("bold");
      if(tier !== "—" && isPacked(b)) sheet.getRange(first + i, 7).setBackground(COLORS.green).setFontColor("#2F5C2B").setFontWeight("bold");
    });
    sheet.getRange(HEAD, 1, n + 1, W).createFilter();
  }else{
    sheet.getRange(HEAD + 1, 1).setValue("No pending or approved bookings right now.").setFontColor(COLORS.muted).setFontStyle("italic");
  }
  [150, 120, 100, 200, 90, 70, 90, 90, 100].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setTabColor(COLORS.gold);
}

// Column widths shared by every table on the Dashboard (A–I).
const DASH_WIDTHS = [130, 150, 115, 230, 190, 230, 150, 110, 310];
const CHART_TOP = 10, CHART_ROWS = 11;                     // the revenue chart panel (rows 10–20), shown only while Revenue is ticked

// One titled table. Returns the next free row. `hl(row)` may return [[col, bg, fg], ...] to highlight cells.
function writeTable(sheet, startRow, title, headers, rows, emptyText, opts){
  opts = opts || {};
  sheet.getRange(startRow, 1).setValue(title).setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink);
  sheet.setRowHeight(startRow, 34);
  const head = startRow + 1, w = headers.length;
  sheet.getRange(head, 1, 1, w).setValues([headers]);
  styleHeaderRow(sheet.getRange(head, 1, 1, w));
  sheet.setRowHeight(head, 28);
  if(!rows.length){
    sheet.getRange(head + 1, 1).setValue(emptyText).setFontColor(COLORS.muted).setFontStyle("italic");
    return head + 3;
  }
  const first = head + 1, n = rows.length;
  for(let c = 1; c <= w; c++) if(c !== opts.moneyCol) sheet.getRange(first, c, n, 1).setNumberFormat("@");   // keep dates/phones as typed
  sheet.getRange(first, 1, n, w).setValues(rows);
  sheet.getRange(first, 1, n, w).setFontSize(10).setVerticalAlignment("middle").setWrap(true)
       .setBackgrounds(rows.map((r, i) => new Array(w).fill(i % 2 ? COLORS.cream : "#FFFFFF")));
  if(opts.boldCol) sheet.getRange(first, opts.boldCol, n, 1).setFontWeight("bold");
  if(opts.moneyCol) sheet.getRange(first, opts.moneyCol, n, 1).setNumberFormat("$#,##0").setHorizontalAlignment("right");
  if(opts.hl) rows.forEach((r, i) => (opts.hl(r, i) || []).forEach(h =>
    sheet.getRange(first + i, h[0]).setBackground(h[1]).setFontColor(h[2]).setFontWeight("bold")));
  return first + n + 2;
}

function money(b){ return (b.total === "" || isNaN(Number(b.total))) ? String(b.total || "—") : Number(b.total); }

// Where the hidden "Open a booking" lookup data lives: far to the right, clear of the visible
// tables (A–I) and the chart helper cells (T onward).
const LOOK_COL = 40;
const LOOKUP_LIMIT = 500;

// Status pill colors (background, text) — same palette as the Bookings tab dropdown.
const STATUS_STYLE = {
  "pending": ["#F5E3B3", "#7A5C14"], "approved": ["#C9E3C6", "#2F5C2B"], "denied": ["#E9C9C9", "#7A2F2F"],
  "rescheduled": ["#D3E3F4", "#2F4C6E"], "no-show": ["#D6C9F0", "#4A3670"], "cancelled": ["#ECE7E4", "#8C7B7E"]
};

function isMoved(b){ return b.status === "denied" || b.status === "rescheduled" || b.status === "cancelled"; }

function whenOf(b){ return (asDate(b.date) + " " + asTime(b.time)).trim() || "—"; }

// What happened to the $ deposit on this booking, in plain words.
function depositText(b, dep){
  if(isRefunded(b)) return "Refunded ✓";
  if(isPaid(b)){
    if(b.status === "denied" || b.status === "cancelled") return "Paid $" + dep + " — refund owed";
    if(b.status === "rescheduled") return "Paid $" + dep + " — carries to the new date";
    return "Paid ✓  $" + dep;
  }
  return "Not paid yet";
}

// "Grand total" = what the client still owes at the appointment: the booking total (the website
// already applied every deal) minus the deposit if it's been paid and not refunded.
// Denied / cancelled / rescheduled bookings owe nothing, so they show blank.
function grandTotalOf(b, dep){
  if(isMoved(b)) return "";
  if(hasGrandOverride(b)) return Number(b.grandTotal);
  if(b.total === "" || isNaN(Number(b.total))) return "";
  const paidIn = isPaid(b) && !isRefunded(b) ? dep : 0;
  return Math.max(0, Number(b.total) - paidIn);
}

function bannerFor(b, dep){
  const owed = isPaid(b) && !isRefunded(b);
  if(b.status === "denied")
    return "✖ DENIED — that day is open again on the website.  " + (owed ? "Deposit of $" + dep + " is owed back — tick \"Deposit refunded\" in Bookings once sent." : isRefunded(b) ? "Deposit already refunded ✓" : "No deposit was taken.");
  if(b.status === "rescheduled")
    return "↻ RESCHEDULED — the original day is open again on the website.  " + (owed ? "Their $" + dep + " deposit carries over to the new booking." : "No deposit was taken yet.");
  if(b.status === "cancelled")
    return "✖ CANCELLED — that day is open again on the website.  " + (owed ? "Deposit of $" + dep + " is owed back." : isRefunded(b) ? "Deposit refunded ✓" : "No deposit was taken.");
  if(b.status === "no-show") return "⚠ NO-SHOW — client didn't arrive.  " + (owed ? "$" + dep + " deposit kept." : "");
  if(b.status === "pending") return "⏳ PENDING — waiting on your reply.  That day is held for them on the website until you decide.";
  if(b.status === "approved") return "✓ APPROVED — " + (isPaid(b) ? "deposit paid, they're all set." : "deposit not marked paid yet.");
  return "";
}

function grandNote(b){
  return hasGrandOverride(b) ? "✎ changed by you — clear the box to go back to automatic" : "automatic: total − deposit paid · type a number to change it";
}

function writeDashboardSheet(all, clients){
  const sheet = getOrCreateSheet("Dashboard");
  const settings = getSettings();
  const dep = settings.depositAmount;

  // Remember what you had open / chosen before the rebuild (the sheet is cleared and redrawn on every refresh).
  const readOld = a1 => { try{ return sheet.getRange(a1).getValue(); }catch(e){ return ""; } };
  const oldRev = readOld(DASH.REV);
  const showRevenue = oldRev === true || oldRev === "Show";
  const prevPick = String(readOld(DASH.PICK));
  const prevKit = String(readOld(DASH.KPICK));
  const prevType = String(readOld(DASH.MAIL_TYPE)), prevSubject = String(readOld(DASH.MAIL_SUBJECT)), prevBody = String(readOld(DASH.MAIL_BODY));

  sheet.getCharts().forEach(c => sheet.removeChart(c));  // rebuilt below so refreshes don't stack duplicates
  sheet.setFrozenRows(0); sheet.setFrozenColumns(0);   // leftovers from older versions block merged banners
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);
  if(sheet.getMaxColumns() < LOOK_COL + 34) sheet.insertColumnsAfter(sheet.getMaxColumns(), LOOK_COL + 34 - sheet.getMaxColumns());
  if(sheet.getMaxRows() < LOOKUP_LIMIT + 5) sheet.insertRowsAfter(sheet.getMaxRows(), LOOKUP_LIMIT + 5 - sheet.getMaxRows());
  sheet.setRowHeights(1, sheet.getMaxRows(), 21);       // clear() keeps old row heights, which would distort the new layout
  sheet.showRows(CHART_TOP, CHART_ROWS);                // re-hidden below when revenue is hidden
  DASH_WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  const tz = Session.getScriptTimeZone();
  const LAST = colLetter(DASH_WIDTHS.length);
  const WHITE = "#FFFFFF";

  // ---------- numbers ----------
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOf = b => { const d = parseDay(b); return d ? dayKey(d) : 99999999; };
  const byDay = (a, c) => dayOf(a) - dayOf(c) || (parseMinutes(a) || 0) - (parseMinutes(c) || 0);

  const pending = all.filter(b => b.status === "pending");
  const approved = all.filter(b => b.status === "approved");
  const overdue = pending.filter(b => waitInfo(b, settings.responseHours).overdue);
  const upcoming = approved.filter(b => !isBundle(b) && !isServiced(b)).sort(byDay);   // approved & not yet done, soonest first
  const awaiting = approved.filter(b => !isBundle(b) && !isPaid(b)).sort(byDay);
  const toRefund = all.filter(b => (b.status === "denied" || b.status === "cancelled") && isPaid(b) && !isRefunded(b));
  const moved = all.filter(isMoved);
  const bundles = all.filter(b => isBundle(b) && isActive(b)).sort(byDay);
  const alertCount = all.filter(b => isActive(b) && hasWarning(b)).length;
  const kitOrdersAll = all.filter(b => isActive(b) && kitTier(b) !== "—");
  const toPack = kitOrdersAll.filter(b => !isPacked(b));
  const unshipped = kitOrdersAll.filter(b => !isShipped(b)).length;
  const luxury = toPack.filter(b => kitTier(b) === "Luxury").length;
  const mini = toPack.filter(b => kitTier(b) === "Mini").length;
  const newest = all.slice().sort(byNewest);   // newest booking first

  // What you actually received counts, when you've typed it in; otherwise the booking total.
  const numeric = b => hasReceived(b) ? Number(b.amountPaid) : (isNaN(Number(b.total)) ? 0 : Number(b.total));
  const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * 86400000);
  const weeks = [];
  for(let k = 7; k >= 0; k--){
    const start = new Date(monday.getTime() - k * 7 * 86400000);
    const end = new Date(start.getTime() + 7 * 86400000);
    const sum = approved.filter(b => { const d = parseDay(b); return d && d >= start && d < end; }).reduce((s, b) => s + numeric(b), 0);
    weeks.push({ label: Utilities.formatDate(start, tz, "MMM d") + " – " + Utilities.formatDate(new Date(end.getTime() - 86400000), tz, "MMM d"), sum: sum });
  }
  const kitLabel = b => kitTier(b) === "—" ? "—" : kitTier(b) + (isComp(b) ? " (comp)" : "");
  const kitProgress = b => kitTier(b) === "—" ? "—" : (isPacked(b) ? "packed" : "not packed") + "  ·  " + (isShipped(b) ? "shipped" : "not shipped");
  const servicedText = b => isServiced(b) ? "Serviced" + (b.servicedOn ? " on " + asDate(b.servicedOn) : " ✓") : "Not serviced yet";

  // Are the click-to-save ticks and the status-dropdown emails switched on? (Needs the one-time setup.)
  let autoNote = "";
  try{
    const on = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === "handleSheetEdit");
    autoNote = on ? "   ·   ✓ ticks & emails are ON" : "   ·   ⚠ ticks & emails are OFF — menu Ehiffect → Turn on approval emails";
  }catch(e){ /* no permission to check — say nothing */ }
  if(CALENDAR_SYNC){
    try{
      const cs = JSON.parse(PropertiesService.getScriptProperties().getProperty("calendarStatus") || "null");
      autoNote += cs ? (cs.ok ? "   ·   📅 calendar synced " + cs.at : "   ·   ⚠ calendar NOT syncing — menu Ehiffect → Sync approved bookings to Google Calendar shows why")
                     : "   ·   📅 calendar: not run yet — menu Ehiffect → Sync approved bookings to Google Calendar";
    }catch(e){}
  }

  // ---------- header ----------
  sheet.getRange("A1:" + LAST + "1").merge().setValue("EHIFFECT").setBackground(COLORS.cream).setFontColor(COLORS.ink)
       .setFontFamily("Cormorant Garamond").setFontSize(30).setFontWeight("bold").setVerticalAlignment("middle").setHorizontalAlignment("center");
  sheet.getRange("A2:" + LAST + "2").merge()
       .setValue("UNCOMPLICATED & AT YOUR SERVICE   ·   updated " + Utilities.formatDate(now, tz, "MMM d, h:mm a") + autoNote)
       .setBackground(COLORS.cream).setFontColor(autoNote.indexOf("⚠") !== -1 ? COLORS.alertText : COLORS.muted)
       .setFontSize(9).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(1, 50); sheet.setRowHeight(2, 22); sheet.setRowHeight(3, 10);

  // ---------- stat tiles: six cards that together span the full width (A–I), same as the header ----------
  const tiles = [
    { span: [1, 2], label: "PENDING",           value: pending.length,   cap: "waiting on you" },
    { span: [3, 4], label: "OVER " + settings.responseHours + "H", value: overdue.length, cap: "reply is overdue", alert: overdue.length > 0 },
    { span: [5, 5], label: "AWAITING DEPOSIT",  value: awaiting.length,  cap: "approved, deposit not marked paid" },
    { span: [6, 6], label: "KITS TO PACK",      value: toPack.length,    cap: luxury + " luxury  ·  " + mini + " mini  ·  " + unshipped + " not shipped" },
    { span: [7, 8], label: "ALERTS",            value: alertCount,       cap: "deals, no-shows, scheduling", alert: alertCount > 0 },
    { span: [9, 9], label: "DENIED / MOVED",    value: moved.length,
      cap: "denied, rescheduled or cancelled" + (toRefund.length ? "  ·  " + toRefund.length + " deposit refund(s) owed" : ""), alert: toRefund.length > 0 }
  ];
  tiles.forEach(t => {
    const [c1, c2] = t.span, w = c2 - c1 + 1;
    const frame = t.alert ? COLORS.alertText : COLORS.pink;
    for(let r = 4; r <= 6; r++) if(w > 1) sheet.getRange(r, c1, 1, w).merge();
    sheet.getRange(4, c1, 3, w).setBackground(t.alert ? COLORS.alertBg : WHITE).setHorizontalAlignment("center").setVerticalAlignment("middle")
         .setBorder(true, true, true, true, false, false, frame, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(4, c1).setValue(t.label).setFontSize(9).setFontWeight("bold").setFontColor(t.alert ? COLORS.alertText : COLORS.muted);
    sheet.getRange(5, c1).setValue(t.value).setNumberFormat("0").setFontFamily("Cormorant Garamond").setFontSize(30)
         .setFontWeight("bold").setFontColor(t.alert ? COLORS.alertText : COLORS.pink);
    sheet.getRange(6, c1).setValue(t.cap).setFontSize(9).setFontColor(t.alert ? COLORS.alertText : COLORS.muted).setWrap(true).setHorizontalAlignment("center");
  });
  sheet.setRowHeight(4, 26); sheet.setRowHeight(5, 50); sheet.setRowHeight(6, 34); sheet.setRowHeight(7, 14);

  // ---------- revenue: one tick to show / hide (row 8). Showing it also reveals the chart panel below. ----------
  const allTime = approved.reduce((s, b) => s + numeric(b), 0);
  const thisMonth = approved.filter(b => { const d = parseDay(b); return d && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear(); })
                            .reduce((s, b) => s + numeric(b), 0);
  const extras = approved.filter(hasReceived).reduce((sum, b) => sum + Math.max(0, Number(b.amountPaid) - (isNaN(Number(b.total)) ? 0 : Number(b.total))), 0);
  sheet.getRange("A8").setValue("Revenue  ▸").setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink).setVerticalAlignment("middle");
  sheet.getRange(DASH.REV).insertCheckboxes().setValue(showRevenue)
       .setBackground(COLORS.blush).setHorizontalAlignment("center").setVerticalAlignment("middle")
       .setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange("C8:" + LAST + "8").merge()
       .setValue(showRevenue
         ? "All-time approved: $" + allTime.toLocaleString("en-US") + "     ·     This month: $" + thisMonth.toLocaleString("en-US") +
           "     ·     Of which extra / tips: $" + extras.toLocaleString("en-US") + "        (untick the box to hide)"
         : "Hidden — tick the box to show your revenue and charts")
       .setFontColor(showRevenue ? COLORS.ink : COLORS.muted).setFontWeight(showRevenue ? "bold" : "normal").setFontSize(11).setVerticalAlignment("middle");
  sheet.setRowHeight(8, 38);

  // ---------- settings you can tweak right here — row 9 (C9, E9, G9) ----------
  sheet.getRange("A9").setValue("Settings").setFontFamily("Cormorant Garamond").setFontSize(13)
       .setFontWeight("bold").setFontColor(COLORS.ink).setVerticalAlignment("middle");
  const settingBox = (a1, v, fmt) => sheet.getRange(a1).setValue(v).setNumberFormat(fmt)
       .setBackground(COLORS.blush).setFontColor(COLORS.pink).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
  const settingLabel = (a1, text) => sheet.getRange(a1).setValue(text).setFontSize(9).setFontColor(COLORS.muted)
       .setHorizontalAlignment("right").setVerticalAlignment("middle");
  settingLabel("B9", "Deposit $");              settingBox("C9", settings.depositAmount, "$#,##0");
  settingLabel("D9", "Reply promise (hrs)");    settingBox("E9", settings.responseHours, "0");
  settingLabel("F9", "Min gap (min)");          settingBox("G9", settings.minGapMinutes, "0");
  sheet.getRange("H9:I9").merge().setValue("Edit a pink box — it saves automatically, no code needed.")
       .setFontSize(9).setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle");
  sheet.setRowHeight(9, 26);

  // ---------- chart panel (rows CHART_TOP…): only exists while Revenue is ticked ----------
  const CHART_DATA_COL = 20;                             // column T onward — hidden helper cells, clear of A–I
  const chartBlock = (offset, rows) => {
    const range = sheet.getRange(1, CHART_DATA_COL + offset * 3, rows.length, 2);
    range.setValues(rows);
    return range;
  };
  // The bordered backgroundColor gives every chart its own clean "panel" card look.
  const pieChart = (range, title, colors, anchorRow, xOffset) =>
    sheet.newChart().setChartType(Charts.ChartType.PIE)
      .addRange(range)
      .setPosition(anchorRow, 1, xOffset, 0)
      .setOption("title", title).setOption("titleTextStyle", { fontSize: 11, bold: true })
      .setOption("pieHole", 0.4).setOption("colors", colors)
      .setOption("legend", { position: "bottom", textStyle: { fontSize: 9 } })
      .setOption("backgroundColor", { fill: WHITE, stroke: COLORS.pink, strokeWidth: 1 })
      .setOption("width", 270).setOption("height", 210)
      .build();

  if(showRevenue){
    const revRange = chartBlock(0, [["Week", "Revenue"]].concat(weeks.map(w => [w.label, w.sum])));
    sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.COLUMN)
      .addRange(revRange)
      .setPosition(CHART_TOP, 1, 0, 0)
      .setOption("title", "Revenue by week").setOption("titleTextStyle", { fontSize: 11, bold: true })
      .setOption("legend", "none").setOption("colors", [COLORS.pink])
      .setOption("hAxis", { textStyle: { fontSize: 8 }, slantedText: true, slantedTextAngle: 30 })
      .setOption("backgroundColor", { fill: WHITE, stroke: COLORS.pink, strokeWidth: 1 })
      .setOption("width", 420).setOption("height", 210)
      .build());
    const collectedAmt = approved.filter(isPaid).length * dep;
    const awaitingAmt = awaiting.length * dep;
    if(collectedAmt + awaitingAmt > 0){
      const depRange = chartBlock(1, [["Status", "Amount"], ["Collected", collectedAmt], ["Awaiting", awaitingAmt]]);
      sheet.insertChart(pieChart(depRange, "Deposits: collected vs. awaiting", [COLORS.pink, COLORS.grey], CHART_TOP, 440));
    }
  }else{
    sheet.hideRows(CHART_TOP, CHART_ROWS);
  }
  sheet.setRowHeight(CHART_TOP + CHART_ROWS, 14);

  // ---------- OPEN A BOOKING (rows 22–31): pick a booking, see and update everything about it ----------
  // The picker is a plain dropdown; the read-only fields are formulas reading a hidden table, so they update
  // instantly. The ticks / boxes on the right are saved to Bookings by handleSheetEdit when you click or type.
  const lookList = newest.slice(0, LOOKUP_LIMIT);
  const n = lookList.length;
  const L = off => colLetter(LOOK_COL + off);
  const MATCH_CELL = "$" + L(20) + "$1", STATUS_CELL = "$" + L(21) + "$1";

  sheet.getRange("A22").setValue("Open a booking").setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink);
  sheet.setRowHeight(22, 34);
  sheet.getRange("A23").setValue("Pick a client ▸").setFontSize(10).setFontWeight("bold").setFontColor(COLORS.muted).setVerticalAlignment("middle");
  sheet.setRowHeight(23, 34);

  if(n === 0){
    sheet.getRange("B23:I23").merge().setValue("No bookings yet — they'll show up here as soon as one comes in.")
         .setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle");
  }else{
    const lookHeaders = ["label", "name", "phone", "ig", "email", "service", "when", "deals", "kit", "notes", "status", "total", "deposit", "grand",
                         "booked", "banner", "serviced", "kitProgress", "rowTag", "lastEmail"];
    const lookRows = lookList.map(b => [
      "#" + b.row + " · " + (b.name || "?") + " · " + (asDate(b.date) || "no date") + " · " + b.status,
      b.name || "—", fmtPhone(b.phone) || "—", b.ig || "—", b.email || "—", b.serviceLabel || "—", whenOf(b),
      b.dealsUsed || "None", kitLabel(b), b.notes || "—", b.status || "—", money(b), depositText(b, dep), grandTotalOf(b, dep),
      asText(b.submittedAt) || "—", bannerFor(b, dep), servicedText(b), kitProgress(b), "#" + b.row, b.lastEmail ? String(b.lastEmail) : "No email sent from the sheet yet"
    ]);
    const moneyCols = [11, 13];                          // everything else is stored as plain text so Sheets can't reinterpret it
    for(let off = 0; off < lookHeaders.length; off++) if(moneyCols.indexOf(off) === -1) sheet.getRange(2, LOOK_COL + off, n, 1).setNumberFormat("@");
    sheet.getRange(1, LOOK_COL, 1, lookHeaders.length).setValues([lookHeaders]);
    sheet.getRange(2, LOOK_COL, n, lookHeaders.length).setValues(lookRows);

    // Keep the booking that was open before this refresh (matched by its #row, since the label includes status).
    const prevRow = (prevPick.match(/^#(\d+)/) || [])[1];
    const kept = prevRow ? lookRows.map(r => r[0]).filter(l => l.indexOf("#" + prevRow + " ·") === 0)[0] : "";
    const openLabel = kept || lookRows[0][0];
    const openRow = Number((openLabel.match(/^#(\d+)/) || [])[1]);
    const openBooking = lookList.filter(b => b.row === openRow)[0];
    sheet.getRange("B23:E23").merge().setValue(openLabel)
         .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(sheet.getRange(2, LOOK_COL, n, 1), true).setAllowInvalid(true).build())
         .setBackground(COLORS.blush).setFontColor(COLORS.pink).setFontWeight("bold").setFontSize(11)
         .setVerticalAlignment("middle").setHorizontalAlignment("left")
         .setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange("F23:I23").merge().setValue("Newest first · the # is the row number in Bookings · includes denied & rescheduled ones")
         .setFontSize(9).setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle").setWrap(true);

    const colRef = off => "$" + L(off) + "$2:$" + L(off) + "$" + (n + 1);
    sheet.getRange(1, LOOK_COL + 20).setFormula("=IFERROR(MATCH($B$23," + colRef(0) + ",0),0)");
    sheet.getRange(1, LOOK_COL + 21).setFormula("=IF(" + MATCH_CELL + "=0,\"\",INDEX(" + colRef(10) + "," + MATCH_CELL + "))");
    const pull = off => "=IF(" + MATCH_CELL + "=0,\"—\",INDEX(" + colRef(off) + "," + MATCH_CELL + "))";

    // status banner (row 24) — the first thing you see for a denied / rescheduled booking
    sheet.getRange("A24:" + LAST + "24").merge()
         .setFormula("=IF(" + MATCH_CELL + "=0,\"Pick a booking above to see everything about it.\",INDEX(" + colRef(15) + "," + MATCH_CELL + "))")
         .setBackground(COLORS.cream).setFontColor(COLORS.ink).setFontWeight("bold").setFontSize(11)
         .setVerticalAlignment("middle").setHorizontalAlignment("left").setWrap(true);
    sheet.setRowHeight(24, 38);

    // details card (rows 25–31). Left + middle blocks: read-only facts. Right block: your ticks and boxes.
    const facts = [   // [label, data offset] for the left block and the middle block of each row
      [["Client", 1], ["Hairstyle", 5]],
      [["Phone", 2], ["Date & time", 6]],
      [["Instagram", 3], ["Deals applied", 7]],
      [["Email", 4], ["Status", 10]],
      [["Booked on", 14], ["Notes", 9]],
      [["Care kit", 8], ["Kit progress", 17]],
      [["Bookings row", 18], ["", -1]]
    ];
    facts.forEach((fr, i) => {
      const r = 25 + i;
      [[fr[0], 1, 2, 3], [fr[1], 4, 5, 6]].forEach(blk => {
        const f = blk[0], lc = blk[1], v1 = blk[2], v2 = blk[3];
        sheet.getRange(r, lc).setValue(f[0]).setFontSize(9).setFontWeight("bold").setFontColor(COLORS.muted).setVerticalAlignment("middle").setBackground(WHITE);
        const val = sheet.getRange(r, v1, 1, v2 - v1 + 1).merge().setBackground(WHITE)
          .setFontSize(11).setFontColor(COLORS.ink).setVerticalAlignment("middle").setHorizontalAlignment("left").setWrap(true);
        if(f[1] >= 0) val.setFormula(pull(f[1]));
        if(f[1] === 1) val.setFontWeight("bold");
      });
      sheet.setRowHeight(r, i === 0 ? 40 : 28);
    });

    const rightRows = [   // [row, label, kind]
      [25, "Total after deals", "total"], [26, "Deposit paid?  ▸", "tick"], [27, "GRAND TOTAL  ▸", "grand"],
      [28, "Money received  ▸", "recv"], [29, "Serviced?  ▸", "tick"], [30, "Kit packed?  ▸", "tick"], [31, "Kit shipped?  ▸", "tick"]
    ];
    rightRows.forEach(rr => {
      sheet.getRange(rr[0], 7).setValue(rr[1]).setFontSize(10).setFontWeight("bold").setVerticalAlignment("middle").setHorizontalAlignment("right")
           .setFontColor(rr[2] === "total" ? COLORS.muted : COLORS.pink).setBackground(WHITE);
      sheet.getRange(rr[0], 8).setBackground(rr[2] === "total" ? WHITE : COLORS.blush).setHorizontalAlignment("center").setVerticalAlignment("middle");
      sheet.getRange(rr[0], 9).setFontSize(9).setFontColor(COLORS.muted).setVerticalAlignment("middle").setHorizontalAlignment("left").setBackground(WHITE).setWrap(true);
    });
    const tick = (a1, on) => sheet.getRange(a1).insertCheckboxes().setValue(!!on);
    sheet.getRange("H25").setFormula(pull(11)).setNumberFormat("$#,##0").setFontWeight("bold").setFontSize(11).setFontColor(COLORS.ink);
    sheet.getRange("I25").setValue("deals already applied");
    tick(DASH.DEP, openBooking && isPaid(openBooking));
    sheet.getRange("I26").setFormula(pull(12));
    sheet.getRange(DASH.GRAND).setValue(openBooking ? grandTotalOf(openBooking, dep) : "").setNumberFormat("$#,##0.00")
         .setFontFamily("Cormorant Garamond").setFontSize(16).setFontWeight("bold").setFontColor(COLORS.pink);
    sheet.getRange(DASH.GRAND_NOTE).setValue(openBooking ? grandNote(openBooking) : "");
    sheet.getRange(DASH.RECV).setValue(openBooking && hasReceived(openBooking) ? Number(openBooking.amountPaid) : "")
         .setNumberFormat("$#,##0.00").setFontWeight("bold").setFontColor(COLORS.pink).setFontSize(11)
         .setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false)
           .setHelpText("Type the total you actually received from this client (deposit + everything else). Clear the cell to remove it.").build());
    const totalAt = "INDEX(" + colRef(11) + "," + MATCH_CELL + ")";
    sheet.getRange("I28").setFormula("=IFERROR(IF(OR(" + MATCH_CELL + "=0,$H$28=\"\"),\"what you actually earned from this client — type it here\",IF($H$28>" + totalAt + ",\"+$\"&TEXT($H$28-" + totalAt + ",\"#,##0.##\")&\" extra / tip\",IF($H$28<" + totalAt + ",\"$\"&TEXT(" + totalAt + "-$H$28,\"#,##0.##\")&\" short of the total\",\"✓ exactly the total\"))),\"\")");
    tick(DASH.SERV, openBooking && isServiced(openBooking));
    sheet.getRange("I29").setFormula(pull(16));
    tick(DASH.PACK, openBooking && isPacked(openBooking));
    sheet.getRange("I30").setFormula(pull(8));
    tick(DASH.SHIP, openBooking && isShipped(openBooking));
    sheet.getRange("I31").setFormula(pull(17));
    sheet.getRange("A25:" + LAST + "31").setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
    sheet.setRowHeight(27, 40);

    // color the banner + the Status field by the opened booking's status
    const bannerRange = sheet.getRange("A24:" + LAST + "24"), statusField = sheet.getRange("E28:F28");
    const pickRules = Object.keys(STATUS_STYLE).map(s => SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied("=" + STATUS_CELL + "=\"" + s + "\"")
      .setBackground(STATUS_STYLE[s][0]).setFontColor(STATUS_STYLE[s][1]).setBold(true)
      .setRanges([bannerRange, statusField]).build());
    sheet.setConditionalFormatRules(pickRules);

    // ---------- SEND AN EMAIL (rows 33–36): a ready-made template you can edit, then tick to send ----------
    sheet.setRowHeight(32, 14);
    sheet.getRange("A33").setValue("Send an email").setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink);
    sheet.getRange("C33:I33").merge().setValue("Goes to the client picked above. Choose a template, tweak the words if you like, then tick \"SEND NOW\".")
         .setFontSize(9).setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle");
    sheet.setRowHeight(33, 34);
    const sameBooking = openBooking && prevRow && Number(prevRow) === openBooking.row && prevBody.trim() && EMAIL_TYPES.indexOf(prevType) !== -1;
    const mailType = sameBooking ? prevType : defaultEmailType(openBooking);
    const mail = sameBooking ? { subject: prevSubject, body: prevBody } : emailTemplate(mailType, openBooking, dep);
    const lab = (a1, text) => sheet.getRange(a1).setValue(text).setFontSize(9).setFontWeight("bold").setFontColor(COLORS.muted).setVerticalAlignment("middle");
    lab("A34", "Template  ▸");
    sheet.getRange("B34:C34").merge().setValue(mailType)
         .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(EMAIL_TYPES, true).setAllowInvalid(false).build())
         .setBackground(COLORS.blush).setFontColor(COLORS.pink).setFontWeight("bold").setVerticalAlignment("middle")
         .setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
    lab("D34", "Subject  ▸");
    sheet.getRange("E34:I34").merge().setValue(mail.subject).setFontSize(11).setFontWeight("bold").setFontColor(COLORS.ink).setVerticalAlignment("middle").setBackground(WHITE)
         .setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
    lab("A35", "Message  ▸");
    sheet.getRange("A35").setVerticalAlignment("top");
    sheet.getRange("B35:I35").merge().setValue(mail.body).setFontSize(10).setFontColor(COLORS.ink).setWrap(true).setVerticalAlignment("top").setBackground(WHITE)
         .setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
    lab("A36", "To  ▸");
    sheet.getRange("B36:F36").merge().setFormula(pull(4)).setFontSize(11).setFontColor(COLORS.ink).setVerticalAlignment("middle");
    sheet.getRange("G36").setValue("SEND NOW  ▸").setFontSize(10).setFontWeight("bold").setFontColor(COLORS.pink).setHorizontalAlignment("right").setVerticalAlignment("middle");
    sheet.getRange(DASH.SEND).insertCheckboxes().setValue(false).setBackground(COLORS.blush).setHorizontalAlignment("center").setVerticalAlignment("middle")
         .setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(DASH.SEND_NOTE).setFontSize(9).setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle").setWrap(true);
    sheet.setRowHeight(34, 30); sheet.setRowHeight(35, 190); sheet.setRowHeight(36, 30);
    // permanent record of the last email sent for this booking (survives refreshes)
    lab("A37", "Last email  ▸");
    sheet.getRange("B37:I37").merge().setFormula(pull(19)).setFontSize(10).setFontWeight("bold").setFontColor(COLORS.ink).setVerticalAlignment("middle");
    sheet.setRowHeight(37, 26);
  }
  if(n === 0) sheet.setRowHeight(37, 14);

  // ---------- KITS (rows 38–41): pick someone who ordered a kit; tick Packed / Shipped ----------
  const kitOrders = kitOrdersAll.slice().sort((a, c) => {
    const ap = isPacked(a), cp = isPacked(c);
    if(ap !== cp) return ap ? 1 : -1;                                  // unpacked kits first
    const da = parseDay(a), dc = parseDay(c);
    return (da ? da.getTime() : 9e15) - (dc ? dc.getTime() : 9e15);    // then soonest appointment
  }).slice(0, 200);
  const KC = LOOK_COL + 24, KL = off => colLetter(KC + off);
  const KMATCH = "$" + KL(8) + "$1";

  sheet.getRange("A38").setValue("Kits" + (kitOrders.length ? "  —  " + toPack.length + " to pack  ·  " + unshipped + " not shipped" : ""))
       .setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink);
  sheet.setRowHeight(38, 34);
  sheet.getRange("A39").setValue("Pick a kit order ▸").setFontSize(10).setFontWeight("bold").setFontColor(COLORS.muted).setVerticalAlignment("middle");
  sheet.setRowHeight(39, 34);

  if(!kitOrders.length){
    sheet.getRange("B39:I39").merge().setValue("No pending or approved bookings have a care kit right now.")
         .setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle");
  }else{
    const kitRows = kitOrders.map(b => [
      "#" + b.row + " · " + (b.name || "?") + " · " + kitLabel(b) + " · " + (asDate(b.date) || "no date") + " · " +
        (isPacked(b) ? "packed ✓" : "TO PACK") + (isShipped(b) ? " · shipped ✓" : ""),
      b.name || "—", kitLabel(b), whenOf(b), b.serviceLabel || "—", b.status
    ]);
    sheet.getRange(2, KC, kitRows.length, 6).setNumberFormat("@");
    sheet.getRange(2, KC, kitRows.length, 6).setValues(kitRows);
    const prevKitRow = (prevKit.match(/^#(\d+)/) || [])[1];
    const keptKit = prevKitRow ? kitRows.map(r => r[0]).filter(l => l.indexOf("#" + prevKitRow + " ·") === 0)[0] : "";
    const pickedLabel = keptKit || kitRows[0][0];
    sheet.getRange("B39:E39").merge().setValue(pickedLabel)
         .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(sheet.getRange(2, KC, kitRows.length, 1), true).setAllowInvalid(true).build())
         .setBackground(COLORS.blush).setFontColor(COLORS.pink).setFontWeight("bold").setFontSize(11)
         .setVerticalAlignment("middle").setHorizontalAlignment("left")
         .setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange("F39:I39").merge().setValue("Kits still to pack come first · only pending/approved bookings that have a kit are listed")
         .setFontSize(9).setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle").setWrap(true);

    const kref = off => "$" + KL(off) + "$2:$" + KL(off) + "$" + (kitRows.length + 1);
    sheet.getRange(1, KC + 8).setFormula("=IFERROR(MATCH($B$39," + kref(0) + ",0),0)");
    const kpull = off => "=IF(" + KMATCH + "=0,\"—\",INDEX(" + kref(off) + "," + KMATCH + "))";
    const kfield = (r, lc, v1, v2, label, off) => {
      sheet.getRange(r, lc).setValue(label).setFontSize(9).setFontWeight("bold").setFontColor(COLORS.muted).setVerticalAlignment("middle").setBackground(WHITE);
      sheet.getRange(r, v1, 1, v2 - v1 + 1).merge().setFormula(kpull(off)).setFontSize(11).setFontColor(COLORS.ink)
           .setVerticalAlignment("middle").setHorizontalAlignment("left").setWrap(true).setBackground(WHITE);
    };
    kfield(40, 1, 2, 3, "Client", 1);   kfield(40, 4, 5, 6, "Kit", 2);
    kfield(41, 1, 2, 3, "Service", 4);  kfield(41, 4, 5, 6, "Appointment", 3);
    sheet.getRange("B40").setFontWeight("bold");
    sheet.getRange("E40").setFontWeight("bold").setFontColor(COLORS.pink);
    const pickedRow = Number((pickedLabel.match(/^#(\d+)/) || [])[1]);
    const pickedBooking = kitOrders.filter(b => b.row === pickedRow)[0];
    [[40, "Packed?  ▸", DASH.KPACK, pickedBooking && isPacked(pickedBooking), "◂ tick when this kit is packed"],
     [41, "Shipped?  ▸", DASH.KSHIP, pickedBooking && isShipped(pickedBooking), "◂ tick once it's shipped / handed over"]].forEach(c => {
      sheet.getRange(c[0], 7).setValue(c[1]).setFontSize(10).setFontWeight("bold").setFontColor(COLORS.pink)
           .setVerticalAlignment("middle").setHorizontalAlignment("right").setBackground(WHITE);
      sheet.getRange(c[2]).insertCheckboxes().setValue(!!c[3]).setHorizontalAlignment("center").setVerticalAlignment("middle").setBackground(COLORS.blush);
      sheet.getRange(c[0], 9).setValue(c[4] + " — saves to Bookings by itself").setFontSize(9)
           .setFontColor(COLORS.muted).setFontStyle("italic").setVerticalAlignment("middle").setBackground(WHITE);
    });
    sheet.setRowHeight(40, 30); sheet.setRowHeight(41, 30);
    sheet.getRange("A40:I41").setBorder(true, true, true, true, false, false, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID);
  }
  sheet.setRowHeight(42, 14);

  // ---------- tables ----------
  let row = 43;

  // Newest bookings first, so the most recent client is always at the top.
  const latest = newest.slice(0, 15);
  const latestRows = latest.map(b => [
    b.status, b.name, fmtPhone(b.phone), b.serviceLabel, whenOf(b), b.dealsUsed || "—",
    isPaid(b) ? (isRefunded(b) ? "Refunded" : "Paid ✓") : "Not paid", money(b),
    "Booked " + (asText(b.submittedAt) || "—") + (hasWarning(b) ? "   ·   ⚠ " + [b.dealAlert, b.checks].filter(Boolean).join(" · ") : "")
  ]);
  row = writeTable(sheet, row, "Latest bookings" + (all.length > latest.length ? "  (newest 15 of " + all.length + " — use the picker above for the rest)" : ""),
    ["Status", "Client", "Phone", "Hairstyle / service", "Date & time", "Deals applied", "Deposit", "Total", "Booked"], latestRows,
    "No bookings yet.",
    { boldCol: 2, moneyCol: 8, hl: (r, i) => {
        const st = STATUS_STYLE[latest[i].status];
        const out = st ? [[1, st[0], st[1]]] : [];
        if(r[6] === "Paid ✓") out.push([7, COLORS.green, "#2F5C2B"]);
        return out;
    } });

  const pendingList = pending.slice().sort((a, c) => {
    const ta = parseSubmitted(a.submittedAt), tc = parseSubmitted(c.submittedAt);
    return (ta ? ta.getTime() : 9e15) - (tc ? tc.getTime() : 9e15);           // oldest first = most urgent
  }).slice(0, 40);
  const pendingRows = pendingList.map(b => [
    waitInfo(b, settings.responseHours).text, b.name, fmtPhone(b.phone), b.serviceLabel, b.dealsUsed || "—",
    [b.dealAlert, b.checks].filter(Boolean).join(" · ") || "—",
    whenOf(b), money(b), messageFor(b, dep)
  ]);
  row = writeTable(sheet, row, "Needs your reply",
    ["Waiting", "Client", "Phone", "Service", "Deals", "Alerts", "Preferred date", "Total", "Text to send (approval)"], pendingRows,
    "You're all caught up — no pending requests.",
    { boldCol: 2, moneyCol: 8, hl: (r, i) => {
        const out = [];
        if(waitInfo(pendingList[i], settings.responseHours).overdue) out.push([1, COLORS.alertBg, COLORS.alertText]);
        if(hasWarning(pendingList[i])) out.push([6, COLORS.alertBg, COLORS.alertText]);
        return out;
    } });

  const scheduleRow = b => [
    asDate(b.date) || "—", b.name, fmtPhone(b.phone), b.serviceLabel, kitLabel(b), isPaid(b) ? "Paid ✓" : "Not paid",
    asTime(b.time) || "—", money(b), messageFor(b, dep)
  ];
  const scheduleOpts = { boldCol: 2, moneyCol: 8, hl: r => {
    const out = [];
    if(r[4].indexOf("Luxury") === 0) out.push([5, COLORS.gold, "#7A5C14"]);
    out.push(r[5] === "Paid ✓" ? [6, COLORS.green, "#2F5C2B"] : [6, COLORS.alertBg, COLORS.alertText]);
    return out;
  } };
  const schedHeaders = ["Date", "Client", "Phone", "Service", "Care kit", "Deposit", "Time", "Total", "Text to send"];

  // Every approved appointment that hasn't been serviced yet, soonest first.
  row = writeTable(sheet, row, "Approved  (" + upcoming.length + ")", schedHeaders, upcoming.slice(0, 60).map(b => scheduleRow(b)),
    "No approved appointments waiting.", scheduleOpts);

  // The tables below only appear when there's something in them, so the page stays short.
  if(toRefund.length){
    const refundRows = toRefund.map(b => [b.name, fmtPhone(b.phone), asDate(b.date) || "—", "$" + dep, "Tick \"Deposit refunded\" in Bookings once it's sent back"]);
    row = writeTable(sheet, row, "Deposits to refund", ["Client", "Phone", "Booking date", "Deposit owed", "Next step"], refundRows, "", { boldCol: 1 });
  }

  if(bundles.length){
    const bundleRows = bundles.map(b => {
      const type = (String(b.serviceLabel).match(/bundle purchase only\s*[—-]\s*(virgin|raw)/i) || [])[1];
      return [asDate(b.date) || "—", b.name, fmtPhone(b.phone), String(b.serviceLabel).replace(/^bundle purchase only\s*[—-]\s*/i, ""),
              kitLabel(b), b.status, type ? type.charAt(0).toUpperCase() + type.slice(1) : "—", money(b), messageFor(b, dep)];
    });
    row = writeTable(sheet, row, "Bundle orders (pickup)",
      ["Pickup date", "Client", "Phone", "Order", "Care kit", "Status", "Hair type", "Total", "Text to send"], bundleRows, "",
      { boldCol: 2, moneyCol: 8, hl: r => r[4].indexOf("Luxury") === 0 ? [[5, COLORS.gold, "#7A5C14"]] : [] });
  }

  // deals at a glance
  const counts = dealSummary(all);
  const dealKeys = Object.keys(DEAL_NAMES);
  row = writeTable(sheet, row, "Deals at a glance", ["Deal", "Times used", "Type"],
    dealKeys.map(k => [DEAL_NAMES[k], counts[k] || 0, ONE_TIME_DEALS.indexOf(k) !== -1 ? "One-time" : "Any time"]), "",
    { hl: r => r[2] === "One-time" ? [[3, COLORS.blush, COLORS.alertText]] : [] });

  // weekly revenue (follows the same tick)
  sheet.getRange(row, 1).setValue("Weekly revenue").setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink);
  sheet.setRowHeight(row, 34);
  sheet.getRange(row + 1, 1, 1, 3).setValues([["Week (by appointment date)", "Revenue", "Trend"]]);
  sheet.getRange(row + 1, 3, 1, 2).merge();
  styleHeaderRow(sheet.getRange(row + 1, 1, 1, 4));
  const maxWeek = Math.max(1, Math.max.apply(null, weeks.map(w => w.sum)));
  weeks.forEach((w, i) => {
    const r = row + 2 + i;
    sheet.getRange(r, 1).setValue(w.label).setNumberFormat("@");
    sheet.getRange(r, 2).setFormula('=IF($B$8=TRUE,' + w.sum + ',"••••")').setNumberFormat("$#,##0").setHorizontalAlignment("right");
    sheet.getRange(r, 3, 1, 2).merge()
         .setFormula('=IF($B$8=TRUE,SPARKLINE(' + w.sum + ',{"charttype","bar";"max",' + maxWeek + ';"color1","' + COLORS.pink + '"}),"")');
    sheet.getRange(r, 1, 1, 4).setBackground(i % 2 ? COLORS.cream : WHITE).setFontSize(10).setVerticalAlignment("middle");
  });
  row = row + 2 + weeks.length + 2;

  // ---------- charts: one row of panels at the very bottom ----------
  sheet.getRange(row, 1).setValue("At a Glance").setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink);
  sheet.setRowHeight(row, 34);
  const chartRow = row + 1;
  let chartX = 0;
  const nextX = () => { const x = chartX; chartX += 282; return x; };

  // Service popularity — which services actually get booked (active bookings only)
  const serviceCounts = {};
  all.filter(isActive).forEach(b => {
    const label = isBundle(b) ? "Bundle" : String(b.serviceLabel || "Other").split(" — ")[0].trim() || "Other";
    serviceCounts[label] = (serviceCounts[label] || 0) + 1;
  });
  const serviceRows = Object.keys(serviceCounts).map(k => [k, serviceCounts[k]]);
  if(serviceRows.length)
    sheet.insertChart(pieChart(chartBlock(2, [["Service", "Count"]].concat(serviceRows)), "Service popularity",
      [COLORS.pink, COLORS.gold, COLORS.green, COLORS.grey, COLORS.blush], chartRow, nextX()));

  // Client breakdown — same categories as the Clients tab
  const clientTypeCounts = { "Awaiting first visit": 0, "New client": 0, "Returning": 0, "Regular": 0 };
  clients.forEach(c => { if(clientTypeCounts[c.type] !== undefined) clientTypeCounts[c.type]++; });
  const clientRows = Object.keys(clientTypeCounts).filter(k => clientTypeCounts[k] > 0).map(k => [k, clientTypeCounts[k]]);
  if(clientRows.length)
    sheet.insertChart(pieChart(chartBlock(3, [["Type", "Count"]].concat(clientRows)), "Client breakdown",
      [COLORS.grey, COLORS.blush, COLORS.green, COLORS.gold], chartRow, nextX()));

  // Kit usage — across active (pending/approved) bookings
  const kitCounts = { "Mini": 0, "Luxury": 0, "None": 0 };
  all.filter(isActive).forEach(b => { const t = kitTier(b); kitCounts[t === "—" ? "None" : t]++; });
  const kitRowsChart = Object.keys(kitCounts).filter(k => kitCounts[k] > 0).map(k => [k, kitCounts[k]]);
  if(kitRowsChart.length)
    sheet.insertChart(pieChart(chartBlock(4, [["Kit", "Count"]].concat(kitRowsChart)), "Kit usage",
      [COLORS.grey, COLORS.blush, COLORS.gold], chartRow, nextX()));

  sheet.hideColumns(CHART_DATA_COL, LOOK_COL + 34 - CHART_DATA_COL);   // chart helper cells + the booking lookup tables
  sheet.setTabColor(COLORS.pink);
}

// "Denied & Rescheduled": every booking that didn't go ahead as booked, newest first, with what
// (if anything) still has to happen to the deposit. Their days are open again on the website.
function writeMovedSheet(all){
  const sheet = getOrCreateSheet("Denied & Rescheduled");
  const dep = getSettings().depositAmount;
  const f = sheet.getFilter(); if(f) f.remove();
  sheet.setFrozenRows(0); sheet.setFrozenColumns(0);
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);

  const headers = ["Status", "Client", "Phone", "Hairstyle / service", "Original date & time", "Deposit", "Total", "What to do", "Notes"];
  const W = headers.length, HEAD = 3;

  sheet.getRange(1, 1, 1, W).merge().setValue("Denied & Rescheduled").setBackground(COLORS.ink).setFontColor(COLORS.cream)
       .setFontFamily("Cormorant Garamond").setFontSize(24).setFontWeight("bold").setVerticalAlignment("middle");
  sheet.getRange(2, 1, 1, W).merge()
       .setValue("Bookings marked denied, rescheduled or cancelled. Their date is open again on the website. Pick one in the Dashboard's \"Open a booking\" box to see everything about it.")
       .setBackground(COLORS.cream).setFontColor(COLORS.muted).setFontSize(9).setWrap(true).setVerticalAlignment("middle");
  sheet.setRowHeight(1, 46); sheet.setRowHeight(2, 34);

  sheet.getRange(HEAD, 1, 1, W).setValues([headers]);
  styleHeaderRow(sheet.getRange(HEAD, 1, 1, W));
  sheet.setRowHeight(HEAD, 32);
  sheet.setFrozenRows(HEAD);

  const rows = all.filter(isMoved).sort(byNewest);
  if(rows.length){
    const n = rows.length, first = HEAD + 1;
    sheet.getRange(first, 1, n, W).setNumberFormat("@");
    sheet.getRange(first, 7, n, 1).setNumberFormat("$#,##0");
    sheet.getRange(first, 1, n, W).setValues(rows.map(b => {
      let todo;
      if(b.status === "rescheduled") todo = isPaid(b) ? "Book their new date — the $" + dep + " deposit carries over" : "Waiting for their new date";
      else if(isRefunded(b)) todo = "Done — deposit refunded ✓";
      else if(isPaid(b)) todo = "Send back $" + dep + ", then tick \"Deposit refunded\" in Bookings";
      else todo = "Nothing owed — no deposit was taken";
      return [b.status, b.name, fmtPhone(b.phone), b.serviceLabel, whenOf(b), depositText(b, dep), money(b), todo, b.notes || "—"];
    }));
    sheet.getRange(first, 1, n, W).setFontSize(10).setVerticalAlignment("middle").setWrap(true)
         .setBackgrounds(rows.map((b, i) => new Array(W).fill(i % 2 ? COLORS.cream : "#FFFFFF")));
    sheet.getRange(first, 2, n, 1).setFontWeight("bold");
    sheet.getRange(first, 7, n, 1).setHorizontalAlignment("right");
    rows.forEach((b, i) => {
      const st = STATUS_STYLE[b.status];
      sheet.getRange(first + i, 1).setBackground(st[0]).setFontColor(st[1]).setFontWeight("bold");
      if(isPaid(b) && !isRefunded(b) && b.status !== "rescheduled")
        sheet.getRange(first + i, 8).setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setFontWeight("bold");
    });
    sheet.getRange(HEAD, 1, n + 1, W).createFilter();
  }else{
    sheet.getRange(HEAD + 1, 1).setValue("Nothing denied or rescheduled — every booking is going ahead.").setFontColor(COLORS.muted).setFontStyle("italic");
  }
  [110, 150, 115, 210, 170, 200, 70, 290, 220].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.setTabColor("#2C4560");
}


/* ================================================================
   8. ONE-TIME SETUP / TIDY-UP  (safe to run any time)
   ================================================================ */

function formatSheet(){
  const repaired = repairLegacyRows();        // 1. rescue rows the old script wrote to the wrong columns
  const compacted = compactBookingsSheet();   // 2. pull any rows stranded at row 1000+ back to the top
  if(REORDER_COLUMNS) reorderBookingColumns();// 3. most-used columns first
  formatBookingsSheet();                      // 4. compact, modern look
  cleanLegacyValues();                        // 5. readable phones, dates, times
  refreshViews();                             // 6. Dashboard + Clients
  let emailNote = "";
  try{ ensureEditTrigger(); }catch(err){ emailNote = " (Approval emails from the Status dropdown could NOT be turned on: " + err.message + ")"; }   // 7. lets the dropdown send email
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ["Dashboard", "Clients", "Kits", "Denied & Rescheduled", "Bookings"].forEach((name, i) => {
    const s = ss.getSheetByName(name);
    if(s){ ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
  });
  ss.setActiveSheet(ss.getSheetByName("Dashboard"));
  const notes = [];
  if(repaired) notes.push("repaired " + repaired + " booking row(s)");
  if(compacted) notes.push("moved " + compacted + " row(s) back up from further down the sheet");
  ss.toast((notes.length ? "Done — " + notes.join(" and ") + " too." : "Done — everything is tidy.") + emailNote, "Ehiffect", 8);
}

// Before the script found columns by header name, it wrote every booking to fixed positions.
// Once a column was inserted in your sheet, those rows landed one column off (the status ended
// up under "pricing", the timestamp under "status"). This moves each such row's values back
// under their correct headers. Healthy rows are never touched, and it's safe to re-run.
function repairLegacyRows(){
  const sheet = getSheet();
  const cols = getColumns(sheet);
  const data = sheet.getDataRange().getValues();
  const OLD_POSITIONS = HEADERS.slice(0, 20);         // the fixed order the old script wrote
  let fixed = 0;
  for(let i = 1; i < data.length; i++){
    const row = data[i];
    if(VALID_STATUSES.indexOf(String(row[cols.map.total]).trim()) === -1) continue;   // healthy: a real total is not a status word
    const out = new Array(cols.width).fill("");
    OLD_POSITIONS.forEach((field, p) => { out[cols.map[field]] = (row[p] === undefined ? "" : row[p]); });
    // If an approval was typed over the timestamp, keep the approval and clear the timestamp.
    const overwritten = String(out[cols.map.submittedAt]).trim();
    if(VALID_STATUSES.indexOf(overwritten) !== -1){
      out[cols.map.status] = overwritten;
      out[cols.map.submittedAt] = "";
    }
    sheet.getRange(i + 1, 1, 1, cols.width).setValues([out]);
    fixed++;
  }
  return fixed;
}

// formatBookingsSheet formats 1000 rows ahead so new bookings inherit the styling — but that
// makes Sheets treat those blank rows as "used", so bookings can end up stranded way down at
// row 1000, 1002, etc. instead of near the top with the rest of your data. This pulls every
// real booking back up so they sit right under the header with no gaps. Safe to re-run.
function compactBookingsSheet(){
  const sheet = getSheet();
  const cols = getColumns(sheet);
  const lastRow = sheet.getLastRow();
  if(lastRow < 2) return 0;
  const data = sheet.getRange(2, 1, lastRow - 1, cols.width).getValues();
  const kept = data.filter(r => r[cols.map.id] || r[cols.map.name] || r[cols.map.phone]);
  if(kept.length === data.length) return 0;             // already contiguous, nothing to do
  sheet.getRange(2, 1, data.length, cols.width).clearContent();
  if(kept.length) sheet.getRange(2, 1, kept.length, cols.width).setValues(kept);
  return kept.length;
}

// Puts the columns you actually use on the left; technical ones go to the right.
function reorderBookingColumns(){
  const sheet = getSheet();
  const width = getColumns(sheet).width;
  sheet.setFrozenColumns(0);
  const filter = sheet.getFilter(); if(filter) filter.remove();
  const everything = sheet.getRange(1, 1, 1, width);
  for(let n = 0; n < 5; n++){ try{ everything.shiftColumnGroupDepth(-1); }catch(e){ break; } }  // clear old groups
  sheet.showColumns(1, width);
  DISPLAY_ORDER.forEach((field, i) => {
    const from = getColumns(sheet).map[field];
    if(from !== i) sheet.moveColumns(sheet.getRange(1, from + 1), i + 1);
  });
}

function formatBookingsSheet(){
  const sheet = getSheet();
  const cols = getColumns(sheet);
  const c = cols.map;
  const ROWS = 300;                                    // formats ahead so new rows inherit it (kept modest — a
                                                        // bigger number formats/conditional-formats more blank
                                                        // rows than you need, which is what makes Sheets feel laggy)

  // A new sheet only has 1000 rows; make room so formatting 1000 rows ahead can't run off the end.
  if(sheet.getMaxRows() < ROWS + 1) sheet.insertRowsAfter(sheet.getMaxRows(), ROWS + 1 - sheet.getMaxRows());
  if(sheet.getMaxColumns() < cols.width) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols.width - sheet.getMaxColumns());

  sheet.setHiddenGridlines(true);
  sheet.setTabColor(COLORS.ink);
  styleHeaderRow(sheet.getRange(1, 1, 1, cols.width));
  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(c.name + 1);                  // keeps the client name visible when scrolling

  // compact widths
  const widths = {
    name: 125, phone: 110, ig: 100, email: 170, date: 85, time: 80, status: 95, depositPaid: 70, depositRefunded: 90,
    serviceLabel: 200, total: 65, amountPaid: 85, grandTotal: 85, lastEmail: 220, dealsUsed: 150, giftKit: 170, careKitCost: 150, kitComp: 85, kitPacked: 85, shipped: 75, serviced: 75, servicedOn: 95, dealAlert: 200,
    checks: 240, notes: 180, submittedAt: 135, photoUrls: 100, bookingType: 95, partnerName: 115, partnerContact: 125
  };
  Object.keys(widths).forEach(f => sheet.setColumnWidth(c[f] + 1, widths[f]));

  // technical columns stay out of sight (their info lives on the Clients tab)
  ["id", "visitCount", "loyaltyFlag", "dealKeys", "approvalEmailed", "calendarEvent"].forEach(f => sheet.hideColumns(c[f] + 1));

  // Partner details fold into a group you can open with the small [+] above the headers.
  if(c.partnerContact - c.bookingType === 2){
    const first = c.bookingType + 1;
    if(sheet.getColumnGroupDepth(first) === 0) sheet.getRange(1, first, 1, 3).shiftColumnGroupDepth(1);
    sheet.getColumnGroup(first, 1).collapse();
  }

  const data = sheet.getRange(2, 1, ROWS, cols.width);
  data.setFontSize(10).setVerticalAlignment("middle");
  ["serviceLabel", "dealsUsed", "dealAlert", "checks", "notes", "giftKit", "careKitCost"].forEach(f =>
    sheet.getRange(2, c[f] + 1, ROWS, 1).setWrap(true));
  ["photoUrls", "dealKeys"].forEach(f =>                // long links get clipped so rows stay short
    sheet.getRange(2, c[f] + 1, ROWS, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP));

  // Plain text for phone/date/time/submittedAt so Sheets can't reinterpret them; tidy price format.
  ["phone", "date", "time", "submittedAt", "servicedOn"].forEach(f =>
    sheet.getRange(2, c[f] + 1, ROWS, 1).setNumberFormat("@"));
  sheet.getRange(2, c.total + 1, ROWS, 1).setNumberFormat("$#,##0");
  sheet.getRange(2, c.amountPaid + 1, ROWS, 1).setNumberFormat("$#,##0.00");
  sheet.getRange(2, c.grandTotal + 1, ROWS, 1).setNumberFormat("$#,##0.00");

  // soft alternating row colors
  sheet.getBandings().forEach(b => b.remove());
  sheet.getRange(2, 1, ROWS, cols.width).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false)
       .setFirstRowColor("#FFFFFF").setSecondRowColor(COLORS.cream);

  // filter buttons on the header row
  const filter = sheet.getFilter(); if(filter) filter.remove();
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), cols.width).createFilter();

  // checkboxes: deposit received, deposit sent back, "this kit was free", and "kit packed"
  [c.depositPaid, c.depositRefunded, c.kitComp, c.kitPacked, c.shipped, c.serviced].forEach(ci =>
    sheet.getRange(2, ci + 1, ROWS, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build())
         .setHorizontalAlignment("center"));

  // status dropdown + colors, alert highlights
  const statusRange = sheet.getRange(2, c.status + 1, ROWS, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(VALID_STATUSES, true).setAllowInvalid(false).build());

  const rules = [
    { text: "approved",  bg: "#C9E3C6", fg: "#2F5C2B" },
    { text: "denied",    bg: "#E9C9C9", fg: "#7A2F2F" },
    { text: "no-show",   bg: "#D6C9F0", fg: "#4A3670" },
    { text: "pending",   bg: "#F5E3B3", fg: "#7A5C14" },
    { text: "rescheduled", bg: "#D3E3F4", fg: "#2F4C6E" },
    { text: "cancelled", bg: COLORS.grey, fg: COLORS.muted }
  ].map(r => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(r.text)
      .setBackground(r.bg).setFontColor(r.fg).setBold(true).setRanges([statusRange]).build());

  const alertRange = sheet.getRange(2, c.dealAlert + 1, ROWS, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied("=LEN($" + colLetter(c.dealAlert + 1) + "2)>0")
    .setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setBold(true).setRanges([alertRange]).build());

  // scheduling / partner / no-show warnings (only lines containing ⚠ turn red)
  const checksRange = sheet.getRange(2, c.checks + 1, ROWS, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=ISNUMBER(SEARCH("⚠",$' + colLetter(c.checks + 1) + '2))')
    .setBackground(COLORS.alertBg).setFontColor(COLORS.alertText).setBold(true).setRanges([checksRange]).build());

  // luxury kits stand out so you know which ones to pack
  [c.giftKit, c.careKitCost].forEach(ci => rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains("Luxury").setBackground(COLORS.gold).setFontColor("#7A5C14").setBold(true)
    .setRanges([sheet.getRange(2, ci + 1, ROWS, 1)]).build()));

  // complimentary kit ticked → gold badge; deposit refunded ticked → green badge
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied("=$" + colLetter(c.kitComp + 1) + "2=TRUE")
    .setBackground(COLORS.gold).setFontColor("#7A5C14").setBold(true)
    .setRanges([sheet.getRange(2, c.kitComp + 1, ROWS, 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied("=$" + colLetter(c.depositRefunded + 1) + "2=TRUE")
    .setBackground(COLORS.green).setFontColor("#2F5C2B").setBold(true)
    .setRanges([sheet.getRange(2, c.depositRefunded + 1, ROWS, 1)]).build());
  [c.kitPacked, c.shipped, c.serviced].forEach(ci => rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied("=$" + colLetter(ci + 1) + "2=TRUE")
    .setBackground(COLORS.green).setFontColor("#2F5C2B").setBold(true)
    .setRanges([sheet.getRange(2, ci + 1, ROWS, 1)]).build()));

  sheet.setConditionalFormatRules(rules);
  SpreadsheetApp.flush();
}

// Rewrites old values into readable text: phone 260-298-2022, dates 09/23/2026, times 2:30 PM,
// and timestamps like 1789652770960 -> 09/19/2026 09:26 AM. Only cells that need it are changed.
function cleanLegacyValues(){
  const sheet = getSheet();
  const c = getColumns(sheet).map;
  const n = sheet.getLastRow() - 1;
  if(n < 1) return;
  const fixers = { phone: fmtPhone, submittedAt: asText, date: asDate, time: asTime };
  Object.keys(fixers).forEach(field => {
    const range = sheet.getRange(2, c[field] + 1, n, 1);
    const before = range.getValues();
    const after = before.map(r => [r[0] === "" ? "" : fixers[field](r[0])]);
    if(after.some((r, i) => String(r[0]) !== String(before[i][0]))){
      range.setNumberFormat("@");
      range.setValues(after);
    }
  });
}

function testEmail(){
  MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: "Test email from Ehiffect script", body: "If you're reading this, email sending works!" });
}
