/**
 * EHIFFECT BOOKING BACKEND
 * ========================
 * This one file powers three things:
 *   1. The booking website  (saves bookings, looks up clients)
 *   2. The "Bookings" sheet (your raw list of every request)
 *   3. Two auto-updating tabs: "Dashboard" and "Clients"
 *
 * SETUP (first time, or after pasting an update)
 *   1. Extensions → Apps Script → delete everything → paste this whole file → Save.
 *   2. Pick "formatSheet" in the function dropdown at the top → Run → approve permissions.
 *   3. Deploy → Manage deployments → pencil icon → Version: New version → Deploy.
 *      (Editing the existing deployment keeps your website URL the same.)
 *   After that, a menu called "Ehiffect" appears in your sheet with a Refresh button.
 *
 * HOW YOUR SHEET WORKS
 *   • Dashboard = your daily view: pending requests (oldest first, with a ready-to-send text),
 *     overdue replies, the next 7 days, deposits still owed, bundle pickups, luxury kits to
 *     pack, deal usage, and revenue (hidden until you pick "Show" in the dropdown).
 *     Warnings marked ⚠ come from checks the sheet runs for you: double-bookings, a partner
 *     who hasn't booked (or booked the same day), a no-show client rebooking, one-time deals reused.
 *     Updates by itself.
 *   • Tick "Deposit" on a booking once you've seen the Cash App payment. Change the numbers
 *     you care about at the top (deposit amount, response hours, gap between appointments).
 *   • Clients   = one row per person: visits, deals they've used, loyalty countdown.
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

const VALID_STATUSES = ["pending", "approved", "denied", "no-show"];

// Used in the ready-to-send text messages.
const CASHTAG = "$ehiixs";
const DEPOSIT_AMOUNT = 20;

// You promise clients a reply within this many hours; older pending requests show as overdue.
const RESPONSE_HOURS = 24;

// Two appointments on the same day starting closer together than this get a scheduling warning.
const MIN_GAP_MINUTES = 120;

// Bookings tab layout: formatSheet puts the columns you use most on the left and the
// technical ones on the right (hidden). Set to false to keep your own column order.
const REORDER_COLUMNS = true;
const DISPLAY_ORDER = [
  "id", "name", "phone", "ig", "date", "time", "status", "depositPaid", "serviceLabel", "total", "dealsUsed",
  "giftKit", "careKitCost", "dealAlert", "checks", "notes", "submittedAt", "photoUrls",
  "bookingType", "partnerName", "partnerContact", "visitCount", "loyaltyFlag", "dealKeys"
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
  "id", "name", "phone", "ig", "date", "time", "notes", "serviceLabel", "total", "status",
  "submittedAt", "photoUrls", "dealsUsed", "bookingType", "partnerName", "partnerContact",
  "giftKit", "careKitCost", "visitCount", "loyaltyFlag", "dealKeys", "dealAlert", "depositPaid", "checks"
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
  if(!me) return;
  const visits = approvedCount(all, me.phone, row) + 1;
  setCell(sheet, cols, "visitCount", row, visits);
  setCell(sheet, cols, "loyaltyFlag", row, visits % LOYALTY_SURPRISE_EVERY === 0);
}


/* ================================================================
   3b. SMART CHECKS — the sheet does the checking so you don't have to
   ================================================================ */

function isBundle(b){ return /^bundle/i.test(String(b.serviceLabel)); }

function isPaid(b){ return b.depositPaid === true || String(b.depositPaid).toUpperCase() === "TRUE"; }

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
function waitInfo(b){
  const d = parseSubmitted(b.submittedAt);
  if(!d) return { text: "—", overdue: false };
  const h = (Date.now() - d.getTime()) / 3600000;
  const text = h < 1 ? "<1h" : h < 24 ? Math.floor(h) + "h" : Math.floor(h / 24) + "d " + Math.floor(h % 24) + "h";
  return { text: text, overdue: h >= RESPONSE_HOURS };
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
function computeChecks(all){
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
    if(i < j && dayKey(a.day) === dayKey(c.day) && Math.abs(a.min - c.min) < MIN_GAP_MINUTES){
      add(a.b.row, "⚠ Too close to " + c.b.name + " (" + asTime(c.b.time) + ")");
      add(c.b.row, "⚠ Too close to " + a.b.name + " (" + asTime(a.b.time) + ")");
    }
  }));

  // Couple's / Bestie Deal: has the partner booked, and on a different day?
  live.filter(b => b.bookingType === "couple" || b.bookingType === "bestie").forEach(a => {
    const label = a.bookingType === "couple" ? "Couple's Deal" : "Bestie Deal";
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
  const checks = computeChecks(all);
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

function messageFor(b){
  const hi = "Hi " + firstName(b) + "! ";
  if(isBundle(b) && b.status !== "denied")
    return hi + "Thanks for your bundle request! I'm confirming pricing and shipping timing and will text you your final price and pickup date shortly.";
  if(b.status === "pending")
    return hi + "Your " + b.serviceLabel + " on " + whenText(b) + " is approved! To lock in your spot, please send the $" + DEPOSIT_AMOUNT +
           " deposit to " + CASHTAG + " on Cash App (it comes off your total at your appointment). Thank you!";
  if(b.status === "approved" && !isPaid(b))
    return hi + "Just a reminder to send your $" + DEPOSIT_AMOUNT + " deposit to " + CASHTAG + " on Cash App to keep your spot on " + whenText(b) + ". Thank you!";
  if(b.status === "approved")
    return hi + "Reminder: your appointment is " + whenText(b) + ". Please come with your hair ready to go (an extra $20 applies for washing/drying) and let me know ASAP if anything changes. See you soon!";
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

function handleCreate(body){
  return withLock(() => {
    const sheet = getSheet();
    const cols = getColumns(sheet);
    const all = readBookings();

    const dealKeys = String(body.dealKeys || "").split(",").map(s => s.trim()).filter(Boolean);
    const dealAlert = dealAlertFor(all, body.phone, dealKeys, -1);
    const visitCount = approvedCount(all, body.phone, -1) + 1;        // their Nth visit IF approved
    const loyaltyFlag = visitCount % LOYALTY_SURPRISE_EVERY === 0;
    const photoUrls = savePhotos(body.photos);
    const id = "b_" + Date.now() + "_" + Math.floor(Math.random() * 10000);

    const values = {
      id: id, name: body.name || "", phone: fmtPhone(body.phone), ig: body.ig || "",
      date: formatDateStr(body.date), time: formatTimeStr(body.time), notes: body.notes || "",
      serviceLabel: body.serviceLabel || "", total: body.total || 0, status: "pending",
      submittedAt: formatTimestamp(Date.now()), photoUrls: photoUrls.join("|"),
      dealsUsed: body.dealsLabel || "", bookingType: body.bookingType || "solo",
      partnerName: body.partnerName || "", partnerContact: body.partnerContact || "",
      giftKit: body.giftKit || "", careKitCost: body.careKitCost || "",
      visitCount: visitCount, loyaltyFlag: loyaltyFlag, dealKeys: dealKeys.join(", "), dealAlert: dealAlert,
      depositPaid: false, checks: ""
    };
    const row = new Array(cols.width).fill("");           // each value goes under its own header
    Object.keys(values).forEach(f => { row[cols.map[f]] = values[f]; });
    sheet.appendRow(row);

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
    if(body.status === "approved") applyApproval(sheet, cols, target.row);
    refreshViews();
    return { ok: true };
  });
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

function toWebsiteShape(b){
  return {
    key: b.id, name: b.name, phone: fmtPhone(b.phone), ig: b.ig, date: asDate(b.date), time: asTime(b.time), notes: b.notes,
    serviceLabel: b.serviceLabel, total: b.total, status: b.status, submittedAt: asText(b.submittedAt),
    photos: b.photoUrls ? String(b.photoUrls).split("|") : [], dealsUsed: b.dealsUsed || "",
    bookingType: b.bookingType || "solo", partnerName: b.partnerName || "", partnerContact: b.partnerContact || "",
    giftKit: b.giftKit || "", careKitCost: b.careKitCost || "", visitCount: b.visitCount || 0,
    loyaltyFlag: b.loyaltyFlag || false, dealKeys: b.dealKeys || "", dealAlert: b.dealAlert || "",
    depositPaid: isPaid(b), checks: b.checks || "", kit: kitTier(b), isBundle: isBundle(b),
    waiting: b.status === "pending" ? waitInfo(b).text : "", overdue: b.status === "pending" && waitInfo(b).overdue,
    text: messageFor(b), textLabel: messageLabel(b)
  };
}

function doGet(e){
  const action = e.parameter.action;

  if(action === "list") return json({ bookings: readBookings().map(toWebsiteShape) });

  // Privacy-friendly: answers yes/no for ONE phone number, never exposes the client list.
  if(action === "checkVisits"){
    const count = approvedCount(readBookings(), e.parameter.phone || "", -1);
    return json({ approvedCount: count, isFirstTime: count === 0 });
  }

  if(action === "create" || action === "updateStatus" || action === "setDeposit"){
    let body;
    try{ body = JSON.parse(e.parameter.payload); }
    catch(err){ return json({ error: "bad payload" }); }
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
  if(body.action === "updateStatus") return json(handleUpdateStatus(body));
  return json({ error: "unknown action" });
}


/* ================================================================
   6. AUTOMATIC UPDATES & MENU
   ================================================================ */

function onOpen(){
  SpreadsheetApp.getUi().createMenu("Ehiffect")
    .addItem("Refresh dashboard & clients", "refreshViews")
    .addItem("Set up / restyle all sheets", "formatSheet")
    .addToUi();
}

// Changing a Status dropdown in the Bookings tab keeps everything else in sync.
function onEdit(e){
  try{
    const sheet = e.range.getSheet();
    if(sheet.getName() !== "Bookings" || e.range.getRow() < 2) return;
    const cols = getColumns(sheet).map;
    const col = e.range.getColumn();
    if([cols.status, cols.depositPaid, cols.date, cols.time].map(i => i + 1).indexOf(col) === -1) return;
    if(col === cols.status + 1 && String(e.value).trim() === "approved") applyApproval(sheet, cols, e.range.getRow());
    refreshViews();
  }catch(err){ /* never interrupt your editing */ }
}


/* ================================================================
   7. DASHBOARD & CLIENTS TABS (rebuilt automatically)
   ================================================================ */

function refreshViews(prefetched){
  try{
    const all = prefetched || readBookings();
    syncChecks(all);
    const clients = buildClients(all);
    writeClientsSheet(clients);
    writeDashboardSheet(all, clients);
  }catch(err){ console.error("refreshViews failed: " + err); }
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
    const last = bs[bs.length - 1];
    const visits = bs.filter(b => b.status === "approved").length;
    const counts = dealSummary(bs);
    const used = Object.keys(counts).map(d => (DEAL_NAMES[d] || d) + (counts[d] > 1 ? " ×" + counts[d] : ""));
    const oneTime = ONE_TIME_DEALS.filter(d => counts[d]).map(d => DEAL_NAMES[d]);
    const ig = bs.map(b => b.ig).filter(Boolean).pop() || "";
    return {
      lastRow: last.row, name: last.name, phone: fmtPhone(last.phone), ig: ig,
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

// Column widths shared by every table on the Dashboard (A–I).
const DASH_WIDTHS = [130, 150, 115, 230, 190, 230, 120, 80, 340];

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

function writeDashboardSheet(all, clients){
  const sheet = getOrCreateSheet("Dashboard");
  let revenueMode = "Hidden";                          // remember your dropdown choice across refreshes
  try{ if(sheet.getRange("B8").getValue() === "Show") revenueMode = "Show"; }catch(e){}
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);
  DASH_WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  const tz = Session.getScriptTimeZone();
  const LAST = colLetter(DASH_WIDTHS.length);

  // ---------- numbers ----------
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in7 = new Date(today.getTime() + 7 * 86400000);
  const dayOf = b => { const d = parseDay(b); return d ? dayKey(d) : 99999999; };
  const byDay = (a, c) => dayOf(a) - dayOf(c) || (parseMinutes(a) || 0) - (parseMinutes(c) || 0);

  const pending = all.filter(b => b.status === "pending");
  const approved = all.filter(b => b.status === "approved");
  const overdue = pending.filter(b => waitInfo(b).overdue);
  const upcoming = approved.filter(b => { const d = parseDay(b); return !isBundle(b) && d && d >= today && d < in7; }).sort(byDay);
  const awaiting = approved.filter(b => !isBundle(b) && !isPaid(b)).sort(byDay);
  const bundles = all.filter(b => isBundle(b) && isActive(b)).sort(byDay);
  const alertCount = all.filter(b => isActive(b) && hasWarning(b)).length;
  const toPack = approved.filter(b => isBundle(b) || upcoming.indexOf(b) !== -1);
  const luxury = toPack.filter(b => kitTier(b) === "Luxury").length;
  const mini = toPack.filter(b => kitTier(b) === "Mini").length;
  const returning = clients.filter(c => c.visits >= 2).length;

  // ---------- header band ----------
  sheet.getRange("A1:" + LAST + "1").merge().setValue("Bookings Overview").setBackground(COLORS.ink).setFontColor(COLORS.cream)
       .setFontFamily("Cormorant Garamond").setFontSize(26).setFontWeight("bold").setVerticalAlignment("middle").setHorizontalAlignment("left");
  sheet.getRange("A2:" + LAST + "2").merge()
       .setValue("Updated " + Utilities.formatDate(now, tz, "MMM d, h:mm a") + "  ·  change a Status or tick a Deposit in the Bookings tab and this refreshes on its own")
       .setBackground(COLORS.ink).setFontColor(COLORS.pink).setFontSize(10).setHorizontalAlignment("left");
  sheet.setRowHeight(1, 54); sheet.setRowHeight(2, 24); sheet.setRowHeight(3, 14);

  // ---------- stat tiles (A–F) ----------
  const tiles = [
    { label: "PENDING",              value: pending.length,   cap: "waiting on you" },
    { label: "OVER " + RESPONSE_HOURS + "H",   value: overdue.length,   cap: "reply is overdue", alert: overdue.length > 0 },
    { label: "AWAITING DEPOSIT",     value: awaiting.length,  cap: "approved, deposit not marked paid" },
    { label: "LUXURY KITS TO PACK",  value: luxury,           cap: mini + " mini  ·  next 7 days + bundle orders" },
    { label: "ALERTS",               value: alertCount,       cap: "deals, no-shows, scheduling", alert: alertCount > 0 },
    { label: "CLIENTS",              value: clients.length,   cap: returning + " returning" }
  ];
  tiles.forEach((t, i) => {
    const col = i + 1;
    sheet.getRange(4, col, 3, 1).setBackground(t.alert ? COLORS.alertBg : COLORS.cream).setHorizontalAlignment("left").setVerticalAlignment("middle")
         .setBorder(true, true, false, true, false, false, "#FFFFFF", SpreadsheetApp.BorderStyle.SOLID_THICK);
    sheet.getRange(4, col).setValue(t.label).setFontSize(9).setFontWeight("bold").setFontColor(t.alert ? COLORS.alertText : COLORS.muted);
    sheet.getRange(5, col).setValue(t.value).setNumberFormat("0").setFontFamily("Cormorant Garamond").setFontSize(30)
         .setFontWeight("bold").setFontColor(t.alert ? COLORS.alertText : COLORS.ink);
    sheet.getRange(6, col).setValue(t.cap).setFontSize(9).setFontColor(t.alert ? COLORS.alertText : COLORS.muted).setWrap(true);
    sheet.getRange(4, col).setBorder(true, null, null, null, null, null, COLORS.pink, SpreadsheetApp.BorderStyle.SOLID_THICK);
  });
  sheet.setRowHeight(4, 26); sheet.setRowHeight(5, 50); sheet.setRowHeight(6, 34); sheet.setRowHeight(7, 18);

  // ---------- revenue (hidden until you pick "Show") ----------
  const numeric = b => (isNaN(Number(b.total)) ? 0 : Number(b.total));
  const allTime = approved.reduce((s, b) => s + numeric(b), 0);
  const thisMonth = approved.filter(b => { const d = parseDay(b); return d && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear(); })
                            .reduce((s, b) => s + numeric(b), 0);
  sheet.getRange("A8").setValue("Revenue").setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink).setVerticalAlignment("middle");
  sheet.getRange("B8").setValue(revenueMode)
       .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["Hidden", "Show"], true).setAllowInvalid(false).build())
       .setBackground(COLORS.blush).setFontColor(COLORS.pink).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.getRange("C8:F8").merge()
       .setFormula('=IF($B$8="Show","All-time approved: $"&TEXT(' + allTime + ',"#,##0")&"     ·     This month: $"&TEXT(' + thisMonth + ',"#,##0"),"Hidden — choose Show in the dropdown to see revenue")')
       .setFontColor(COLORS.muted).setFontSize(11).setVerticalAlignment("middle");
  sheet.setRowHeight(8, 38);

  // ---------- tables ----------
  let row = 10;

  const pendingList = pending.slice().sort((a, c) => {
    const ta = parseSubmitted(a.submittedAt), tc = parseSubmitted(c.submittedAt);
    return (ta ? ta.getTime() : 9e15) - (tc ? tc.getTime() : 9e15);           // oldest first = most urgent
  }).slice(0, 40);
  const pendingRows = pendingList.map(b => [
    waitInfo(b).text, b.name, fmtPhone(b.phone), b.serviceLabel, b.dealsUsed || "—",
    [b.dealAlert, b.checks].filter(Boolean).join(" · ") || "—",
    (asDate(b.date) + " " + asTime(b.time)).trim() || "—", money(b), messageFor(b)
  ]);
  row = writeTable(sheet, row, "Needs your attention",
    ["Waiting", "Client", "Phone", "Service", "Deals", "Alerts", "Preferred date", "Total", "Text to send (approval)"], pendingRows,
    "You're all caught up — no pending requests.",
    { boldCol: 2, moneyCol: 8, hl: (r, i) => {
        const out = [];
        if(waitInfo(pendingList[i]).overdue) out.push([1, COLORS.alertBg, COLORS.alertText]);
        if(hasWarning(pendingList[i])) out.push([6, COLORS.alertBg, COLORS.alertText]);
        return out;
    } });

  const scheduleRow = b => [
    asDate(b.date) || "—", b.name, fmtPhone(b.phone), b.serviceLabel, kitTier(b), isPaid(b) ? "Paid ✓" : "Not paid",
    asTime(b.time) || "—", money(b), messageFor(b)
  ];
  const scheduleOpts = { boldCol: 2, moneyCol: 8, hl: r => {
    const out = [];
    if(r[4] === "Luxury") out.push([5, COLORS.gold, "#7A5C14"]);
    out.push(r[5] === "Paid ✓" ? [6, COLORS.green, "#2F5C2B"] : [6, COLORS.alertBg, COLORS.alertText]);
    return out;
  } };
  const schedHeaders = ["Date", "Client", "Phone", "Service", "Care kit", "Deposit", "Time", "Total", "Text to send"];

  row = writeTable(sheet, row, "Next 7 days", schedHeaders, upcoming.map(b => scheduleRow(b)),
    "No approved appointments in the next 7 days.", scheduleOpts);
  row = writeTable(sheet, row, "Awaiting deposit", schedHeaders, awaiting.map(b => scheduleRow(b)),
    "Every approved appointment has its deposit marked paid.", scheduleOpts);

  const bundleRows = bundles.map(b => {
    const type = (String(b.serviceLabel).match(/bundle purchase only\s*[—-]\s*(virgin|raw)/i) || [])[1];
    return [asDate(b.date) || "—", b.name, fmtPhone(b.phone), String(b.serviceLabel).replace(/^bundle purchase only\s*[—-]\s*/i, ""),
            kitTier(b), b.status, type ? type.charAt(0).toUpperCase() + type.slice(1) : "—", money(b), messageFor(b)];
  });
  row = writeTable(sheet, row, "Bundle orders (pickup)",
    ["Pickup date", "Client", "Phone", "Order", "Care kit", "Status", "Hair type", "Total", "Text to send"], bundleRows,
    "No open bundle orders.", { boldCol: 2, moneyCol: 8, hl: r => r[4] === "Luxury" ? [[5, COLORS.gold, "#7A5C14"]] : [] });

  // deals at a glance
  const counts = dealSummary(all);
  const dealKeys = Object.keys(DEAL_NAMES);
  row = writeTable(sheet, row, "Deals at a glance", ["Deal", "Times used", "Type"],
    dealKeys.map(k => [DEAL_NAMES[k], counts[k] || 0, ONE_TIME_DEALS.indexOf(k) !== -1 ? "One-time" : "Any time"]), "",
    { hl: r => r[2] === "One-time" ? [[3, COLORS.blush, COLORS.alertText]] : [] });

  // weekly revenue (follows the same dropdown)
  sheet.getRange(row, 1).setValue("Weekly revenue").setFontFamily("Cormorant Garamond").setFontSize(18).setFontWeight("bold").setFontColor(COLORS.ink);
  sheet.setRowHeight(row, 34);
  sheet.getRange(row + 1, 1, 1, 3).setValues([["Week (by appointment date)", "Revenue", "Trend"]]);
  sheet.getRange(row + 1, 3, 1, 2).merge();
  styleHeaderRow(sheet.getRange(row + 1, 1, 1, 4));
  const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * 86400000);
  const weeks = [];
  for(let k = 7; k >= 0; k--){
    const start = new Date(monday.getTime() - k * 7 * 86400000);
    const end = new Date(start.getTime() + 7 * 86400000);
    const sum = approved.filter(b => { const d = parseDay(b); return d && d >= start && d < end; }).reduce((s, b) => s + numeric(b), 0);
    weeks.push({ label: Utilities.formatDate(start, tz, "MMM d") + " – " + Utilities.formatDate(new Date(end.getTime() - 86400000), tz, "MMM d"), sum: sum });
  }
  const maxWeek = Math.max(1, Math.max.apply(null, weeks.map(w => w.sum)));
  weeks.forEach((w, i) => {
    const r = row + 2 + i;
    sheet.getRange(r, 1).setValue(w.label).setNumberFormat("@");
    sheet.getRange(r, 2).setFormula('=IF($B$8="Show",' + w.sum + ',"••••")').setNumberFormat("$#,##0").setHorizontalAlignment("right");
    sheet.getRange(r, 3, 1, 2).merge()
         .setFormula('=IF($B$8="Show",SPARKLINE(' + w.sum + ',{"charttype","bar";"max",' + maxWeek + ';"color1","' + COLORS.pink + '"}),"")');
    sheet.getRange(r, 1, 1, 4).setBackground(i % 2 ? COLORS.cream : "#FFFFFF").setFontSize(10).setVerticalAlignment("middle");
  });
  sheet.setTabColor(COLORS.pink);
}


/* ================================================================
   8. ONE-TIME SETUP / TIDY-UP  (safe to run any time)
   ================================================================ */

function formatSheet(){
  const repaired = repairLegacyRows();        // 1. rescue rows the old script wrote to the wrong columns
  if(REORDER_COLUMNS) reorderBookingColumns();// 2. most-used columns first
  formatBookingsSheet();                      // 3. compact, modern look
  cleanLegacyValues();                        // 4. readable phones, dates, times
  refreshViews();                             // 5. Dashboard + Clients
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ["Dashboard", "Clients", "Bookings"].forEach((name, i) => {
    const s = ss.getSheetByName(name);
    if(s){ ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
  });
  ss.setActiveSheet(ss.getSheetByName("Dashboard"));
  ss.toast(repaired ? "Done — repaired " + repaired + " booking row(s) too." : "Done — everything is tidy.", "Ehiffect", 8);
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
  const ROWS = 1000;                                   // formats ahead so new rows inherit it

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
    name: 125, phone: 110, ig: 100, date: 85, time: 80, status: 95, depositPaid: 70, serviceLabel: 200, total: 65,
    dealsUsed: 150, giftKit: 170, careKitCost: 150, dealAlert: 200, checks: 240, notes: 180, submittedAt: 135,
    photoUrls: 100, bookingType: 95, partnerName: 115, partnerContact: 125
  };
  Object.keys(widths).forEach(f => sheet.setColumnWidth(c[f] + 1, widths[f]));

  // technical columns stay out of sight (their info lives on the Clients tab)
  ["id", "visitCount", "loyaltyFlag", "dealKeys"].forEach(f => sheet.hideColumns(c[f] + 1));

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
  ["phone", "date", "time", "submittedAt"].forEach(f =>
    sheet.getRange(2, c[f] + 1, ROWS, 1).setNumberFormat("@"));
  sheet.getRange(2, c.total + 1, ROWS, 1).setNumberFormat("$#,##0");

  // soft alternating row colors
  sheet.getBandings().forEach(b => b.remove());
  sheet.getRange(2, 1, ROWS, cols.width).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false)
       .setFirstRowColor("#FFFFFF").setSecondRowColor(COLORS.cream);

  // filter buttons on the header row
  const filter = sheet.getFilter(); if(filter) filter.remove();
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), cols.width).createFilter();

  // deposit checkbox (tick it once you've seen the Cash App payment)
  sheet.getRange(2, c.depositPaid + 1, ROWS, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build())
       .setHorizontalAlignment("center");

  // status dropdown + colors, alert highlights
  const statusRange = sheet.getRange(2, c.status + 1, ROWS, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(VALID_STATUSES, true).setAllowInvalid(false).build());

  const rules = [
    { text: "approved", bg: "#C9E3C6", fg: "#2F5C2B" },
    { text: "denied",   bg: "#E9C9C9", fg: "#7A2F2F" },
    { text: "no-show",  bg: "#D6C9F0", fg: "#4A3670" },
    { text: "pending",  bg: "#F5E3B3", fg: "#7A5C14" }
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
